# Knowledge-transfer plan

Goal: the client's team (2 developers, 1 Data engineer, the run team) can operate, change and
release Ops Pulse **without the original developer**, at the end of the mission.

## 1. Principles

- **Docs as code:** everything needed is in this repository and reviewed like code; the KT
  sessions walk through it rather than replacing it.
- **Learn by doing:** after each session, the receiver performs the task on staging while the
  transmitter watches ("I do, we do, you do").
- **Measured exit:** the transfer ends on demonstrated tasks (§4), not on hours spent.

## 2. Sessions

| #  | Topic                                    | Audience            | Length | Material                                                                        | Hands-on exercise                                         |
| -- | ---------------------------------------- | ------------------- | ------ | ------------------------------------------------------------------------------- | --------------------------------------------------------- |
| 1  | Why and what: legacy, target, decisions  | all                 | 1.5 h  | [legacy analysis](../analysis/legacy-analysis.md), [target architecture](../architecture/target-architecture.md), [ADRs](../adr/README.md) | Explain one ADR back to the group                          |
| 2  | Local setup and gates                    | devs, Data          | 2 h    | [developer guide](../handbook/developer-guide.md), `AGENTS.md`                   | Run the stack; make a failing test pass; open an MR        |
| 3  | API: layers, security, SQL               | devs                | 3 h    | [detailed design](../architecture/detailed-design.md), [security](../ops/security.md) | Add a filter to `/changes` with test, schema, index check |
| 4  | SPA: state, data fetching, ECharts       | devs                | 3 h    | `apps/web/AGENTS.md`, detailed design §5                                         | Add a chart option builder with its test                   |
| 5  | Dataiku flow and KPI definitions         | Data, devs          | 3 h    | `dataiku/AGENTS.md`, detailed design §4, [ServiceNow integration](../handbook/servicenow-integration.md) | Change the anomaly threshold in a branch; run tests and the local runner |
| 6  | Database: migrations, tuning, backups    | devs, DBA           | 2 h    | [migration plan](../migration/migration-plan.md), [maintenance](../ops/maintenance.md) | Write an expand migration; restore a backup on staging     |
| 7  | CI/CD and deployment on RHEL             | devs, run team      | 2.5 h  | `.gitlab-ci.yml`, [installation](../ops/installation.md), `deploy/`             | Tag a release, deploy to staging, roll back                 |
| 8  | Run: monitoring, incidents, changes      | run team            | 2 h    | [operations runbook](../ops/operations.md)                                       | Game day: KPI job failure + API down, resolved with the runbook |
| 9  | Agile practices and backlog handover     | PO, team            | 1 h    | [way of working](../agile/way-of-working.md), open backlog                       | Team runs refinement of the next sprint alone              |

Sessions are recorded (screen + voice) and the recordings are linked from `docs/README.md` of the
client's GitLab instance.

## 3. Pairing schedule

| Weeks | Mode                                                   | Who leads              |
| ----- | ------------------------------------------------------ | ---------------------- |
| 1–2   | Sessions 1–4; pairing on stories, transmitter drives   | transmitter            |
| 3–4   | Sessions 5–9; pairing, receiver drives                 | receiver, with support |
| 5     | Shadow: the team runs the sprint; transmitter reviews MRs only | receiver       |
| 6     | Reverse shadow: transmitter available on request only   | receiver               |

## 4. Exit criteria (all demonstrated on staging)

- [ ] A client developer delivered a story end to end (test first → MR → review → merge → staging)
- [ ] A client developer added a migration following expand → migrate → contract
- [ ] The Data engineer changed and re-ran the KPI flow; tests green; dashboard updated
- [ ] The run team deployed a tagged release and rolled it back with the scripts
- [ ] The run team restored a backup on staging within the RTO (1 h)
- [ ] The game-day incidents were resolved using only the runbook
- [ ] Every open question from the sessions is answered in the docs (not in a chat)
- [ ] Access handed over: GitLab maintainer roles, registry tokens, DSS project ownership,
      vault secrets; the transmitter's accesses revoked

## 5. Handover package

Repository (code + docs), the list of open backlog items and known limitations (release notes),
recordings, credentials handover record (who holds which secret — never the values), and a
30-day support window for questions.
