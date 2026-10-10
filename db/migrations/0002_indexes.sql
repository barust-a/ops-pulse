-- Indexes for the API's read paths. Each one names the query it serves; drop it with that query.

-- /incidents?service=…&from=…&to=… and the Dataiku daily aggregation per service: equality on
-- service, then a range on opened_at, so service leads.
create index incidents_service_opened_at_idx on ops.incidents (service, opened_at);

-- Open-incident counts (/kpis/summary.openIncidents) and the open backlog: a partial index stays
-- small because only ~15 % of incidents are unresolved at any time.
create index incidents_open_opened_at_idx on ops.incidents (opened_at) where resolved_at is null;

-- /incidents default sort (-openedAt) and the /kpis/by-priority and /kpis/heatmap date ranges
-- without a service filter, which the (service, opened_at) index cannot serve.
create index incidents_opened_at_idx on ops.incidents (opened_at);

-- Change failure rate per service over a closing window (Dataiku) and /changes?service=….
create index changes_service_closed_at_idx on ops.changes (service, closed_at);

-- /changes?from=…&to=… filters and sorts on the planned window start.
create index changes_planned_start_idx on ops.changes (planned_start);

-- Joining an incident to the change that caused it (ServiceNow 'caused_by'): only the few
-- linked incidents are indexed.
create index incidents_caused_by_change_idx on ops.incidents (caused_by_change)
  where caused_by_change is not null;

-- Foreign key lookups: Postgres does not index the referencing side of a foreign key.
create index incidents_assignment_group_id_idx on ops.incidents (assignment_group_id);
