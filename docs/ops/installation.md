# Installation guide

How to install Ops Pulse on a laptop (demo) and on a RHEL 9 server (staging, production).
Files referenced here live in [`deploy/`](../../deploy/).

## 1. Laptop (demo, any OS with Docker)

Prerequisites: Docker Engine 24+ with the Compose plugin ≥ 2.24 (`docker compose version`), 4 GB RAM.

```sh
cp deploy/compose/.env.example deploy/compose/.env    # fake, dev-only values
docker compose -f deploy/compose/docker-compose.yml up --build
```

Open <http://localhost:8080> and sign in with a demo account (test-only, from the seed):
`admin@ops-pulse.test`, `analyst@ops-pulse.test` or `viewer@ops-pulse.test`, password `OpsPulse!2026`.

What happens: `postgres` starts → `migrate` applies `db/migrations` and loads the demo seed →
`api` starts once migrations succeeded → `kpi-job` runs the Dataiku flow once → `web` serves the
SPA on port 8080. PostgreSQL is published on `127.0.0.1:5432` for `psql`.

Stop: `docker compose -f deploy/compose/docker-compose.yml down` (add `-v` to delete the data).

## 2. RHEL 9 server

### 2.1 Sizing

| Environment | vCPU | RAM  | Disk                                   |
| ----------- | ---- | ---- | -------------------------------------- |
| Staging     | 2    | 4 GB | 40 GB (`/var/lib/docker` + backups)    |
| Production  | 4    | 8 GB | 80 GB; backups on a separate volume/NFS |

### 2.2 Packages and container engine

```sh
sudo dnf -y update
sudo dnf -y install dnf-plugins-core curl rsync policycoreutils-python-utils
# Docker CE from Docker's repository for RHEL (Podman is the RHEL default; see ADR 0005).
sudo dnf config-manager --add-repo https://download.docker.com/linux/rhel/docker-ce.repo
sudo dnf -y install docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo systemctl enable --now docker
docker compose version     # must be ≥ 2.24
```

Log rotation for containers is set per service in `docker-compose.prod.yml` (json-file, 5 × 10 MB).

### 2.3 Directory layout and secrets

```sh
sudo install -d -m 755 /opt/ops-pulse /opt/ops-pulse/.deploy
sudo install -d -m 700 /var/backups/ops-pulse
# Deployment files: shipped by the GitLab deploy job (rsync of deploy/), or copied once by hand:
sudo rsync -a deploy/ /opt/ops-pulse/deploy/
sudo install -m 600 deploy/compose/.env.example /opt/ops-pulse/deploy/compose/.env
sudoedit /opt/ops-pulse/deploy/compose/.env
```

In `.env` on a server:

| Variable                  | Value                                                                      |
| ------------------------- | -------------------------------------------------------------------------- |
| `OPS_PULSE_IMAGE_PREFIX`  | the GitLab registry path, e.g. `registry.gitlab.example.com/ops/ops-pulse` |
| `POSTGRES_PASSWORD`       | `openssl rand -base64 32`                                                  |
| `JWT_SECRET`              | `openssl rand -base64 48` (≥ 32 chars)                                     |
| `CORS_ORIGIN`             | the public URL, e.g. `https://ops-pulse.example.com`                       |
| `SEED_DEMO_DATA`          | `false` (the production override forces it anyway)                         |
| `SAML_*`                  | only when SSO is enabled ([ADR 0004](../adr/0004-jwt-now-saml-behind-flag.md)) |

Registry access with a **read-only deploy token** (GitLab → Settings → Repository → Deploy tokens,
scope `read_registry`), for the account that runs the deploy:

```sh
docker login registry.gitlab.example.com -u <deploy-token-user>   # password read from stdin
```

### 2.4 Network: firewalld

Only HTTPS is exposed; the API (3000) and PostgreSQL (5432) are never published in production.

```sh
sudo firewall-cmd --permanent --add-service=https
# Only if users reach the containerised Nginx directly on 8080 (no host reverse proxy):
# sudo firewall-cmd --permanent --add-port=8080/tcp
sudo firewall-cmd --reload
```

### 2.5 SELinux

Keep SELinux **enforcing**. Notes for this setup:

- Named volumes (`pgdata`) are labelled by Docker automatically. If you switch to **bind mounts**,
  add `:Z` (private) or `:z` (shared) to the volume so the container can read it, e.g.
  `- /srv/ops-pulse/pgdata:/var/lib/postgresql/data:Z`.
- With Nginx or Apache **on the host** proxying to the API on `127.0.0.1:3000`, allow the web
  server to open network connections: `sudo setsebool -P httpd_can_network_connect 1`.
- Static files served by a host web server need the right context:
  `sudo semanage fcontext -a -t httpd_sys_content_t '/var/www/ops-pulse(/.*)?' && sudo restorecon -Rv /var/www/ops-pulse`.
- Diagnose denials with `sudo ausearch -m avc -ts recent` (never by disabling SELinux).

### 2.6 systemd units

```sh
sudo cp /opt/ops-pulse/deploy/systemd/ops-pulse*.service /opt/ops-pulse/deploy/systemd/ops-pulse*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable ops-pulse.service
sudo systemctl enable --now ops-pulse-kpi.timer ops-pulse-backup.timer
systemctl list-timers 'ops-pulse*'
```

| Unit                          | Role                                                                    |
| ----------------------------- | ----------------------------------------------------------------------- |
| `ops-pulse.service`           | Starts `postgres`, `api`, `web` at boot (oneshot, `RemainAfterExit`)    |
| `ops-pulse-kpi.timer/.service`| Runs the Dataiku flow (`kpi-job`) daily at 06:00 Europe/Paris           |
| `ops-pulse-backup.timer/.service` | `backup-db.sh` daily at 05:30, 14-day retention                     |

When DSS runs the flow itself (scenario "Daily KPIs"), leave `ops-pulse-kpi.timer` disabled so the
table has a single writer.

### 2.7 First deployment

```sh
sudo /opt/ops-pulse/deploy/scripts/deploy.sh --tag v0.1.0
sudo systemctl start ops-pulse.service
```

`deploy.sh` pulls the images, starts PostgreSQL, applies migrations, starts the API and Nginx,
waits for their health checks, runs a smoke test (`/healthz`, `/api/v1/health` with `db: up`,
SPA index) and records the release in `/opt/ops-pulse/.deploy/release.env` for systemd and
`rollback.sh`. Then create the real users (admin procedure in the [user guide](../handbook/user-guide.md#accounts-and-roles)).

### 2.8 Optional: Nginx or Apache on the host

When the site standard is a web server on the host (TLS certificates managed there):

- **Nginx:** `dnf install nginx`; copy `deploy/nginx/ops-pulse.conf` to `/etc/nginx/conf.d/`,
  `deploy/nginx/snippets/ops-pulse-security-headers.conf` to `/etc/nginx/snippets/`, change the
  upstream to `127.0.0.1:3000`, `listen 443 ssl` with the certificate, copy `apps/web/dist` to
  `/usr/share/nginx/ops-pulse`; `nginx -t && systemctl enable --now nginx`.
- **Apache:** follow the header of `deploy/apache/ops-pulse.conf`.
- In both cases publish the API container on loopback only: add
  `ports: ["127.0.0.1:3000:3000"]` to `api` in a local override file, and do not start `web`.

### 2.9 Verify

```sh
curl -fsS http://127.0.0.1:8080/api/v1/health   # {"status":"ok","db":"up","version":"…"}
systemctl status ops-pulse.service
docker compose --project-directory /opt/ops-pulse/deploy/compose \
  -f /opt/ops-pulse/deploy/compose/docker-compose.yml -f /opt/ops-pulse/deploy/compose/docker-compose.prod.yml ps
```

Next: [operations runbook](operations.md), [security](security.md), [maintenance](maintenance.md).
