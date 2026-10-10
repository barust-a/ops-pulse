-- Deterministic synthetic incidents and changes for the integration test (UTC timestamps).
-- Day n = 2026-01-01 + n days, n = 0..89 (2026-01-01 .. 2026-03-31).
--
-- payments: 1 incident on even n, 3 on odd n, each resolved in 30 minutes (SLA 60 minutes), except
--   * n = 63 (2026-03-05): also resolves INC-long, opened 2025-12-15, 115200 minutes late on SLA;
--   * n = 78 (2026-03-20): spike of 12 incidents resolved in 10, 20, ... 120 minutes (6 breach);
--   * n = 83 (2026-03-25): no incident at all;
--   * n = 88 (2026-03-30): one more incident, still in progress.
-- crm: exactly 2 incidents every day (zero variance: no z-score).
-- identity: no incident, one change; it must still get a row for every day.
-- changes on 2026-03-12: payments 2 successful + 1 unsuccessful + 1 backed_out (+ 1 cancelled and
-- 1 still implementing, both ignored); crm 1 successful. identity: 1 successful on 2026-03-15.

CREATE TEMP SEQUENCE incident_number START 10001;
CREATE TEMP SEQUENCE change_number START 30001;

INSERT INTO ops.assignment_groups (name) VALUES ('Payments Ops'), ('CRM Ops');

INSERT INTO ops.incidents
    (number, short_description, priority, state, category, service, assignment_group_id,
     opened_at, resolved_at, sla_due_at)
SELECT
    'INC' || lpad(nextval('incident_number')::text, 7, '0'),
    'Card authorisations slow', 3, 'resolved', 'software', 'payments', 1,
    t.opened_at, t.opened_at + interval '30 minutes', t.opened_at + interval '60 minutes'
FROM generate_series(0, 89) AS n
CROSS JOIN LATERAL generate_series(1, CASE WHEN mod(n, 2) = 0 THEN 1 ELSE 3 END) AS k
CROSS JOIN LATERAL (
    SELECT timestamptz '2026-01-01 08:00:00+00' + n * interval '1 day' + k * interval '10 minutes'
        AS opened_at
) AS t
WHERE n NOT IN (78, 83);

INSERT INTO ops.incidents
    (number, short_description, priority, state, category, service, assignment_group_id,
     opened_at, resolved_at, sla_due_at)
SELECT
    'INC' || lpad(nextval('incident_number')::text, 7, '0'),
    'Payment gateway errors', 1, 'resolved', 'network', 'payments', 1,
    t.opened_at, t.opened_at + k * interval '10 minutes', t.opened_at + interval '60 minutes'
FROM generate_series(1, 12) AS k
CROSS JOIN LATERAL (
    SELECT timestamptz '2026-03-20 08:00:00+00' + k * interval '10 minutes' AS opened_at
) AS t;

INSERT INTO ops.incidents
    (number, short_description, priority, state, category, service, assignment_group_id,
     opened_at, resolved_at, sla_due_at)
VALUES
    ('INC9000001', 'Refund batch stuck since December', 4, 'resolved', 'software', 'payments', 1,
     '2025-12-15 00:00:00+00', '2026-03-05 00:00:00+00', '2025-12-15 01:00:00+00'),
    ('INC9000002', 'Settlement file late', 2, 'in_progress', 'software', 'payments', 1,
     '2026-03-30 12:00:00+00', NULL, '2026-03-30 16:00:00+00');

INSERT INTO ops.incidents
    (number, short_description, priority, state, category, service, assignment_group_id,
     opened_at, resolved_at, sla_due_at)
SELECT
    'INC' || lpad(nextval('incident_number')::text, 7, '0'),
    'CRM search slow', 3, 'resolved', 'software', 'crm', 2,
    t.opened_at, t.opened_at + interval '30 minutes', t.opened_at + interval '60 minutes'
FROM generate_series(0, 89) AS n
CROSS JOIN generate_series(1, 2) AS k
CROSS JOIN LATERAL (
    SELECT timestamptz '2026-01-01 09:00:00+00' + n * interval '1 day' + k * interval '10 minutes'
        AS opened_at
) AS t;

INSERT INTO ops.changes
    (number, short_description, type, risk, state, close_code, service,
     planned_start, planned_end, closed_at)
SELECT
    'CHG' || lpad(nextval('change_number')::text, 7, '0'),
    c.description, 'normal', 'moderate', c.state, c.close_code, c.service,
    timestamptz '2026-03-12 12:00:00+00', timestamptz '2026-03-12 13:00:00+00', c.closed_at
FROM (
    VALUES
        ('Gateway TLS renewal', 'closed', 'successful', 'payments', timestamptz '2026-03-12 14:00:00+00'),
        ('Fraud rules v42', 'closed', 'unsuccessful', 'payments', timestamptz '2026-03-12 14:10:00+00'),
        ('Ledger schema change', 'closed', 'backed_out', 'payments', timestamptz '2026-03-12 14:20:00+00'),
        ('PSP failover test', 'closed', 'successful', 'payments', timestamptz '2026-03-12 14:30:00+00'),
        ('Card BIN refresh', 'cancelled', NULL, 'payments', timestamptz '2026-03-12 15:00:00+00'),
        ('3DS provider switch', 'implement', NULL, 'payments', NULL),
        ('CRM index rebuild', 'closed', 'successful', 'crm', timestamptz '2026-03-12 16:00:00+00'),
        ('SSO certificate rotation', 'closed', 'successful', 'identity', timestamptz '2026-03-15 10:00:00+00')
) AS c (description, state, close_code, service, closed_at);
