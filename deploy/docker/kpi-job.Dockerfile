# syntax=docker/dockerfile:1
# Ops Pulse KPI job: runs the Dataiku flow (dataiku/) outside DSS with its local runner, writing
# ops.daily_service_kpis. It mirrors the Dataiku scenario "daily KPIs" for hosts without DSS.
# Build context: the repository root, e.g.
#   docker build -f deploy/docker/kpi-job.Dockerfile -t ops-pulse/kpi-job:local .

ARG PYTHON_IMAGE=registry.access.redhat.com/ubi9/python-311:1

FROM ${PYTHON_IMAGE} AS runtime
ARG APP_VERSION=0.0.0-local
ARG VCS_REF=unknown
LABEL org.opencontainers.image.title="ops-pulse-kpi-job" \
      org.opencontainers.image.description="Ops Pulse Dataiku flow runner (daily service KPIs)" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.licenses="UNLICENSED"

# The UBI Python image runs as 1001 with an activated virtualenv in /opt/app-root.
USER 1001
WORKDIR /opt/app-root/src
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    # Same import roots as DSS: the project library and the local `dataiku` API shim.
    # local_runner/__init__.py also inserts them; PYTHONPATH makes them explicit for the image.
    PYTHONPATH=/opt/app-root/src/python-lib:/opt/app-root/src/local_runner/shim

COPY --chown=1001:0 dataiku/requirements.txt ./requirements.txt
RUN pip install -r requirements.txt
COPY --chown=1001:0 dataiku/ ./

# Default window: 120 days ending today (Europe/Paris); override with --from/--to YYYY-MM-DD.
# Exit codes: 0 ok, 1 failed run or ERROR-level check, 2 usage error.
CMD ["python", "-m", "local_runner.run_flow"]
