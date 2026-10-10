# ADR-0005: Red Hat UBI 9 images, Docker Compose and systemd on RHEL 9

**Date**: 2026-10-10
**Status**: accepted
**Deciders**: Alexandre Barusta (lead developer), infrastructure / run team, security officer

## Context

Production servers are RHEL 9 virtual machines managed by the run team, with SELinux enforcing and
firewalld. There is no Kubernetes platform for this application. SupervIT v1 is deployed by
manual FTP uploads, with no staging and no rollback. The mission asks for Docker / Docker Compose
deployments on Linux Red Hat, systemd services and Apache or Nginx.

## Decision

Package the API, the SPA (with Nginx) and the KPI job as OCI images built on Red Hat Universal
Base Image 9 (`ubi9/nodejs-22`, `ubi9/nodejs-22-minimal`, `ubi9/nginx-126`, `ubi9/python-311`),
non-root, pushed to the GitLab registry by CI. Run them with Docker Compose
(`deploy/compose/docker-compose.yml` + a production override), started by a systemd unit, with
systemd timers for the daily KPI job and backups, and scripted deploy / rollback.

## Alternatives Considered

### Alternative 1: Alpine or Debian base images
- **Pros**: smaller images; wider community examples.
- **Cons**: not covered by the Red Hat support the run team relies on; different libc and
  package tooling from the hosts.
- **Why not**: UBI is freely redistributable, supported on RHEL, and patched by Red Hat.

### Alternative 2: Kubernetes / OpenShift
- **Pros**: self-healing, rolling updates, horizontal scaling.
- **Cons**: no cluster is available; operating one for three containers is out of proportion.
- **Why not**: Compose on one VM meets the availability target; the images are ready for
  OpenShift later (non-root, arbitrary-uid friendly, health checks).

### Alternative 3: RPMs and services directly on the host
- **Pros**: no container engine.
- **Cons**: Node and Python runtimes on the host drift from CI; harder rollback.
- **Why not**: images are immutable and identical from CI to production.

## Consequences

### Positive
- One artefact per component and commit (`:<short sha>`, `:<vX.Y.Z>`); rollback = previous tag.
- Read-only root filesystems, dropped capabilities, no privilege escalation in production.
- systemd integrates with the run team's tooling (journald, monitoring of failed units).

### Negative
- Docker CE on RHEL 9 comes from Docker's repository (Podman is Red Hat's default engine);
  the Compose files also run with `podman compose`, which must be validated if Podman is imposed.
- A single host is a single point of failure (RTO 1 h via redeploy + restore).

### Risks
- Base images move (`:1` tags): CI rebuilds weekly and Trivy blocks critical vulnerabilities;
  production can pin digests.
