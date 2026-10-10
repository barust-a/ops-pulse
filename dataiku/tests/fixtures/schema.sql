-- Test copy of the `ops` schema from docs/specs/2026-10-10-ops-pulse-contract.md.
-- The canonical, versioned DDL lives in db/migrations (owned by the API); this copy only lets the
-- Dataiku integration test run against a scratch database.

CREATE EXTENSION IF NOT EXISTS citext;
CREATE SCHEMA ops;

CREATE TABLE ops.users (
    id bigserial PRIMARY KEY,
    email citext UNIQUE NOT NULL,
    password_hash text NOT NULL,
    role text NOT NULL CHECK (role IN ('viewer', 'analyst', 'admin')),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ops.assignment_groups (
    id serial PRIMARY KEY,
    name text UNIQUE NOT NULL
);

CREATE TABLE ops.incidents (
    id bigserial PRIMARY KEY,
    number text UNIQUE NOT NULL,
    short_description text NOT NULL,
    priority smallint NOT NULL CHECK (priority BETWEEN 1 AND 4),
    state text NOT NULL CHECK (state IN ('new', 'in_progress', 'on_hold', 'resolved', 'closed')),
    category text NOT NULL,
    service text NOT NULL,
    assignment_group_id int REFERENCES ops.assignment_groups (id),
    opened_at timestamptz NOT NULL,
    resolved_at timestamptz NULL,
    sla_due_at timestamptz NOT NULL,
    caused_by_change text NULL
);

CREATE INDEX incidents_service_opened_at_idx ON ops.incidents (service, opened_at);
CREATE INDEX incidents_open_opened_at_idx ON ops.incidents (opened_at) WHERE resolved_at IS NULL;

CREATE TABLE ops.changes (
    id bigserial PRIMARY KEY,
    number text UNIQUE NOT NULL,
    short_description text NOT NULL,
    type text NOT NULL CHECK (type IN ('standard', 'normal', 'emergency')),
    risk text NOT NULL CHECK (risk IN ('low', 'moderate', 'high')),
    state text NOT NULL CHECK (state IN ('scheduled', 'implement', 'review', 'closed', 'cancelled')),
    close_code text NULL CHECK (close_code IN ('successful', 'unsuccessful', 'backed_out')),
    service text NOT NULL,
    planned_start timestamptz,
    planned_end timestamptz,
    closed_at timestamptz NULL
);

CREATE INDEX changes_service_closed_at_idx ON ops.changes (service, closed_at);

CREATE TABLE ops.daily_service_kpis (
    day date NOT NULL,
    service text NOT NULL,
    incident_count int NOT NULL,
    resolved_count int NOT NULL,
    mttr_minutes numeric(10, 2),
    p90_resolution_minutes numeric(10, 2),
    sla_breach_rate numeric(5, 4) NOT NULL,
    change_count int NOT NULL,
    change_failure_rate numeric(5, 4) NOT NULL,
    incident_zscore numeric(6, 3),
    is_anomaly boolean NOT NULL,
    computed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (day, service)
);
