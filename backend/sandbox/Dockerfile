# Per-REMi workspace container: /sh and approved registry tools run here, never on the host.
# Build: docker build -t remi-sandbox backend/sandbox
FROM python:3.12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates git jq procps \
 && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --shell /bin/bash remi \
 && mkdir -p /tools/bin /workspace \
 && chown remi:remi /tools/bin /workspace

ENV PATH="/tools/bin:${PATH}"
USER remi
WORKDIR /workspace
CMD ["sleep", "infinity"]
