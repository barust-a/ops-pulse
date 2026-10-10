-- Ops Pulse initial schema (docs/specs/2026-10-10-ops-pulse-contract.md, "Database").
-- Applied once by apps/api/src/scripts/migrate.ts inside a transaction; never edit after it ran:
-- add a new NNNN_name.sql instead (the migrator refuses a changed checksum).

create schema if not exists ops;
create extension if not exists citext;

create table ops.users (
  id            bigserial primary key,
  email         citext not null unique,
  password_hash text not null,
  role          text not null check (role in ('viewer', 'analyst', 'admin')),
  created_at    timestamptz not null default now()
);

create table ops.assignment_groups (
  id   serial primary key,
  name text not null unique
);

-- Numbers POST /incidents gives new incidents ('INC0010001'). The seed writes its own numbers
-- and moves the sequence past them.
create sequence ops.incident_number_seq start with 10001;

create table ops.incidents (
  id                  bigserial primary key,
  number              text not null unique check (number ~ '^INC[0-9]{7}$'),
  short_description   text not null check (length(short_description) between 1 and 160),
  priority            smallint not null check (priority between 1 and 4),
  state               text not null
                        check (state in ('new', 'in_progress', 'on_hold', 'resolved', 'closed')),
  category            text not null,
  service             text not null,
  -- Not null: every incident is routed to a group, and the API's Incident.assignmentGroup is a
  -- non-null string.
  assignment_group_id int not null references ops.assignment_groups (id),
  opened_at           timestamptz not null,
  resolved_at         timestamptz null,
  sla_due_at          timestamptz not null,
  caused_by_change    text null,
  -- A resolved or closed incident has a resolution time, an open one has none.
  constraint incidents_resolution_matches_state
    check ((state in ('resolved', 'closed')) = (resolved_at is not null)),
  constraint incidents_resolved_after_opened
    check (resolved_at is null or resolved_at >= opened_at)
);

create table ops.changes (
  id                bigserial primary key,
  number            text not null unique check (number ~ '^CHG[0-9]{7}$'),
  short_description text not null,
  type              text not null check (type in ('standard', 'normal', 'emergency')),
  risk              text not null check (risk in ('low', 'moderate', 'high')),
  state             text not null
                      check (state in ('scheduled', 'implement', 'review', 'closed', 'cancelled')),
  close_code        text null check (close_code in ('successful', 'unsuccessful', 'backed_out')),
  service           text not null,
  -- Not null: the API's Change.plannedStart/plannedEnd are non-null strings.
  planned_start     timestamptz not null,
  planned_end       timestamptz not null,
  closed_at         timestamptz null,
  -- Only a closed change carries a close code.
  constraint changes_close_code_only_when_closed
    check (close_code is null or state = 'closed'),
  constraint changes_planned_window_ordered
    check (planned_end >= planned_start)
);

-- Written by the Dataiku flow, read by the API (/kpis/summary, /kpis/daily). Days are UTC.
-- sla_breach_rate = breached / resolved that day; change_failure_rate = (unsuccessful +
-- backed_out) / changes closed that day, cancelled excluded; both 0 without a denominator.
-- The minute columns and the z-score stay null when nothing was resolved or the history is flat.
create table ops.daily_service_kpis (
  day                    date not null,
  service                text not null,
  incident_count         int not null,
  resolved_count         int not null,
  mttr_minutes           numeric(10, 2),
  p90_resolution_minutes numeric(10, 2),
  sla_breach_rate        numeric(5, 4) not null,
  change_count           int not null,
  change_failure_rate    numeric(5, 4) not null,
  incident_zscore        numeric(6, 3),
  is_anomaly             boolean not null,
  computed_at            timestamptz not null default now(),
  primary key (day, service)
);
