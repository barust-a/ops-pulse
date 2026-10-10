-- DSS SQL query recipe: incidents_prepared + changes_raw -> daily_service_base (PostgreSQL 16).
--
-- One row per (calendar day, service) from kpi_from_date minus the baseline window to kpi_to_date,
-- days without any activity included, so the Python recipe can compute rolling statistics on a
-- gap-free series. Days are UTC calendar days.
--
--   incident_count       incidents opened that day
--   resolved_count       incidents resolved that day; MTTR, p90 and SLA breaches are measured on them
--   mttr_minutes         mean (resolved_at - opened_at), NULL when nothing was resolved
--   p90_resolution_...   percentile_cont(0.9), linear interpolation, NULL when nothing was resolved
--   sla_breach_count     resolved after sla_due_at
--   change_count         changes closed that day (state = 'closed', cancelled ones excluded)
--   failed_change_count  closed with close_code unsuccessful or backed_out
--   baseline_*_28d       trailing mean / sample stddev of incident_count over the baseline window,
--                        current day excluded, NULL under kpi_baseline_min_days days: the SQL
--                        push-down twin of ops_kpis.rolling_zscore (parity is tested).
--
-- Rates stay as numerator + denominator here; the Python recipe divides them with a zero guard, so
-- a weekly or cross-service rate can still be re-aggregated as a ratio of sums.
--
-- ${...} are DSS project variables (expanded as text by DSS; bound as parameters by the local runner).
--
-- Plan notes (EXPLAIN ANALYZE on the integration fixture, PostgreSQL 16):
--   * params and window_bounds are NOT MATERIALIZED: the planner inlines them and folds the window
--     bounds to constants. Materialised (the default for a CTE referenced several times), each range
--     check became a Join Filter against the one CTE row, which no index can serve.
--   * changes_raw: on the fixture's 8 rows a Seq Scan wins; with enable_seqscan off, the folded
--     closed_at range is an Index Cond on the contract index changes(service, closed_at). closed_at
--     is its SECOND column and PostgreSQL 16 has no skip scan, so that walks the whole index rather
--     than seeking; a changes(closed_at) index, or PostgreSQL 18 skip scan, makes it a range seek.
--   * incidents_prepared is the sync recipe's in-database copy and has no index: Seq Scan, Sort,
--     GroupAggregate. The window predicates are half-open ranges on the raw timestamptz columns
--     (never a function of the column), so they stay sargable: on ops.incidents they would use
--     incidents(service, opened_at) like changes above, and a day-partitioned copy prunes on them.
--   * The calendar x services grid (generate_series over integers added to a date, no timezone
--     round-trip) is sorted once by (service, day); the three LEFT JOINs run as Merge Joins on that
--     order and the WindowAgg and the final ORDER BY reuse it without another sort.

WITH params AS NOT MATERIALIZED (
    SELECT
        CAST('${kpi_from_date}' AS date) - ${kpi_baseline_days} AS first_day,
        CAST('${kpi_to_date}' AS date) AS last_day
),

window_bounds AS NOT MATERIALIZED (
    SELECT
        first_day,
        last_day,
        first_day::timestamp AT TIME ZONE 'UTC' AS starts_at,
        (last_day + 1)::timestamp AT TIME ZONE 'UTC' AS ends_at
    FROM params
),

calendar AS (
    SELECT b.first_day + day_offset AS day
    FROM window_bounds AS b
    CROSS JOIN LATERAL generate_series(0, b.last_day - b.first_day) AS day_offset
),

window_changes AS (
    SELECT
        c.service,
        (c.closed_at AT TIME ZONE 'UTC')::date AS day,
        c.close_code
    FROM ops.changes AS c
    CROSS JOIN window_bounds AS b
    WHERE c.closed_at >= b.starts_at
      AND c.closed_at < b.ends_at
      AND c.state = 'closed'
),

-- Every service ever seen, so a quiet service still gets one row per day. On changes this is an
-- index-only scan of changes(service, closed_at) once the table is vacuumed.
services AS (
    SELECT service FROM incidents_prepared
    UNION
    SELECT service FROM ops.changes
),

opened_per_day AS (
    SELECT
        i.service,
        (i.opened_at AT TIME ZONE 'UTC')::date AS day,
        count(*) AS incident_count
    FROM incidents_prepared AS i
    CROSS JOIN window_bounds AS b
    WHERE i.opened_at >= b.starts_at
      AND i.opened_at < b.ends_at
    GROUP BY i.service, (i.opened_at AT TIME ZONE 'UTC')::date
),

resolutions AS (
    SELECT
        i.service,
        (i.resolved_at AT TIME ZONE 'UTC')::date AS day,
        EXTRACT(EPOCH FROM i.resolved_at - i.opened_at)::double precision / 60.0
            AS resolution_minutes,
        i.resolved_at > i.sla_due_at AS sla_breached
    FROM incidents_prepared AS i
    CROSS JOIN window_bounds AS b
    WHERE i.resolved_at >= b.starts_at
      AND i.resolved_at < b.ends_at
),

resolved_per_day AS (
    SELECT
        service,
        day,
        count(*) AS resolved_count,
        avg(resolution_minutes) AS mttr_minutes,
        percentile_cont(0.9) WITHIN GROUP (ORDER BY resolution_minutes) AS p90_resolution_minutes,
        count(*) FILTER (WHERE sla_breached) AS sla_breach_count
    FROM resolutions
    GROUP BY service, day
),

changes_per_day AS (
    SELECT
        service,
        day,
        count(*) AS change_count,
        count(*) FILTER (WHERE close_code IN ('unsuccessful', 'backed_out')) AS failed_change_count
    FROM window_changes
    GROUP BY service, day
),

daily AS (
    SELECT
        cal.day,
        s.service,
        coalesce(o.incident_count, 0)::integer AS incident_count,
        coalesce(r.resolved_count, 0)::integer AS resolved_count,
        r.mttr_minutes,
        r.p90_resolution_minutes,
        coalesce(r.sla_breach_count, 0)::integer AS sla_breach_count,
        coalesce(c.change_count, 0)::integer AS change_count,
        coalesce(c.failed_change_count, 0)::integer AS failed_change_count
    FROM calendar AS cal
    CROSS JOIN services AS s
    LEFT JOIN opened_per_day AS o ON o.service = s.service AND o.day = cal.day
    LEFT JOIN resolved_per_day AS r ON r.service = s.service AND r.day = cal.day
    LEFT JOIN changes_per_day AS c ON c.service = s.service AND c.day = cal.day
)

SELECT
    d.day,
    d.service,
    d.incident_count,
    d.resolved_count,
    d.mttr_minutes,
    d.p90_resolution_minutes,
    d.sla_breach_count,
    d.change_count,
    d.failed_change_count,
    CASE WHEN count(*) OVER baseline >= ${kpi_baseline_min_days}
        THEN avg(d.incident_count) OVER baseline
    END::double precision AS baseline_mean_28d,
    CASE WHEN count(*) OVER baseline >= ${kpi_baseline_min_days}
        THEN stddev_samp(d.incident_count) OVER baseline
    END::double precision AS baseline_stddev_28d
FROM daily AS d
WINDOW baseline AS (
    PARTITION BY d.service
    ORDER BY d.day
    ROWS BETWEEN ${kpi_baseline_days} PRECEDING AND 1 PRECEDING
)
ORDER BY d.service, d.day
