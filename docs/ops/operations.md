# Operations runbook

For the run team (N1/N2) and the on-call developer. Commands assume a server installed per the
[installation guide](installation.md). Shorthand used below:

```sh
alias opc='docker compose --project-directory /opt/ops-pulse/deploy/compose -f /opt/ops-pulse/deploy/compose/docker-compose.yml -f /opt/ops-pulse/deploy/compose/docker-compose.prod.yml'
```

## 1. Health

| Check                   | Command / URL                                             | Healthy                                           |
| ----------------------- | --------------------------------------------------------- | ------------------------------------------------- |
| Web tier                | `curl -fsS http://127.0.0.1:8080/healthz`                 | `ok`                                              |
| API + database          | `curl -fsS http://127.0.0.1:8080/api/v1/health`           | `{"status":"ok","db":"up","version":"<tag>"}`     |
| Containers              | `opc ps`                                                  | `api`, `web`, `postgres` "running (healthy)"      |
| systemd                 | `systemctl status ops-pulse.service`                      | `active (exited)` — oneshot, containers managed by Docker |
| KPI job last run        | `systemctl status ops-pulse-kpi.service`; `systemctl list-timers 'ops-pulse*'` | last result `success`, next 06:00 |
| KPI freshness (SQL)     | `opc exec postgres psql -U ops_pulse -d ops_pulse -c "select max(day), max(computed_at) from ops.daily_service_kpis"` | `max(day)` = yesterday |

Suggested monitoring: probe `/api/v1/health` every minute (alert after 3 failures); alert on
`ops-pulse-kpi.service` failure (systemd `OnFailure=` hook or the monitoring agent's failed-unit
check); disk usage of `/var/lib/docker` and `/var/backups` > 80 %.

## 2. Logs

| Source                 | Command                                                        |
| ---------------------- | -------------------------------------------------------------- |
| API (JSON, pino)       | `opc logs --since 1h api` — filter: `… | grep '"level":50'` (errors) |
| Nginx (JSON access)    | `opc logs --since 1h web`                                      |
| PostgreSQL             | `opc logs --since 1h postgres`                                 |
| KPI job                | `journalctl -u ops-pulse-kpi.service --since today`            |
| Backups                | `journalctl -u ops-pulse-backup.service --since today`         |
| Stack start/stop       | `journalctl -u ops-pulse.service`                              |

Every request carries a **request id**: Nginx generates it (`request_id` in its log) and forwards
`X-Request-Id`; the API logs the same id with each request. To follow one user report, find the
request in the Nginx log, then `opc logs api | grep <request id>`. Passwords, tokens and
`Authorization` headers are redacted at the source.

## 3. Start, stop, restart

```sh
sudo systemctl restart ops-pulse.service     # whole stack (brief outage)
opc restart api                              # API only (≈ 5 s)
opc up -d --no-deps --force-recreate web     # recreate one container from its image
sudo systemctl stop ops-pulse.service        # stop everything (data kept in the volume)
```

Deploy and rollback: `deploy/scripts/deploy.sh --tag <tag>` and `deploy/scripts/rollback.sh`
(details in [maintenance](maintenance.md#releases-and-rollback)).

## 4. KPI job failures

Symptom: the "Vue d’ensemble" page shows "Aucune donnée KPI — lancez le flow Dataiku", or the
KPI freshness query returns a `max(day)` older than yesterday.

1. **Which runner?** In DSS: open the project → Scenarios → "Daily KPIs" → last run log. On the
   host: `journalctl -u ops-pulse-kpi.service -n 200`.
2. **Typical causes**

   | Log says                                         | Cause                                           | Action                                                |
   | ------------------------------------------------ | ----------------------------------------------- | ----------------------------------------------------- |
   | connection refused / timeout                     | PostgreSQL down or credentials changed          | `opc ps`; check `.env`; restart `postgres`            |
   | permission denied (temp table or `daily_service_kpis`) | DB role lacks `TEMP` or write grant      | grant `TEMP` on the database and `INSERT, UPDATE` on `ops.daily_service_kpis` |
   | missing columns / schema error                   | migration not applied, or contract drift        | `opc run --rm --no-deps migrate`; compare with the contract spec |
   | non-contiguous days / base frame error           | gap in the SQL recipe output (sync outage)      | re-run the ServiceNow sync for the gap, then the flow |
   | rate out of range / check failed                 | data quality issue upstream                     | look at the rows of that day; open a ticket to the Data team |

3. **Re-run** after fixing: `sudo systemctl start ops-pulse-kpi.service` (or "Run" on the DSS
   scenario). The whole run is **one transaction** with an idempotent upsert on `(day, service)`:
   a failed run leaves the previous KPIs untouched, and the timer, a manual re-run or an
   overlapping DSS run cannot duplicate rows. Exit codes of the runner: 0 ok, 1 failed run or
   ERROR-level check, 2 usage error.
   Backfill an older period (default window: 120 days ending today, Europe/Paris):
   `opc run --rm --no-deps kpi-job python -m local_runner.run_flow --from 2026-01-01 --to 2026-03-31`.
4. Confirm with the freshness query and reload the dashboard.

## 5. Incident handling (Ops Pulse itself)

Ops Pulse incidents are managed in **ServiceNow** like any other service (assignment group
"Ops Pulse support"). Priorities follow the impact × urgency matrix:

| Situation                                              | Priority | First actions                                                 |
| ------------------------------------------------------ | -------- | ------------------------------------------------------------- |
| Application down for everyone (health KO)              | P2       | health checks §1 → `opc logs` → restart → rollback if it follows a deploy |
| Login impossible (all users)                           | P2       | API logs for 401/500 on `/auth/login`; `JWT_SECRET` changed? IdP down (SAML)? |
| KPIs missing or stale                                   | P3       | §4                                                            |
| Slow pages (> 5 s)                                      | P3       | `opc exec postgres psql … -c "select * from pg_stat_activity where state <> 'idle'"`; recent deploy? |
| Suspected security event (brute force, data leak)      | P1 security | Follow the [security guide](security.md#incident-response); preserve logs |

Decision rule after a deploy: if a P1/P2 starts within an hour of a release, **roll back first,
investigate after** (`rollback.sh`). Every P1/P2 gets a blameless post-mortem within 5 working
days, with actions tracked in the backlog.

## 6. Planned changes

Production deployments are **changes** in ServiceNow: a *standard* change for a release that
only passes the pipeline (no migration, no config change), a *normal* change (CAB) when the
release contains a migration that locks or rewrites data, or a new configuration. Attach the
release notes and the rollback plan. Emergency fixes follow the *emergency* change process.
