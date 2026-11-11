#!/usr/bin/env bash
# Wipe every trace in Jaeger and every metric in Prometheus.
# Both keep data in memory only, so recreating the two containers empties them.
# The app, the collector and your .env are untouched.
set -euo pipefail
cd "$(dirname "$0")"
docker compose up -d --force-recreate --renew-anon-volumes jaeger prometheus
echo "Jaeger and Prometheus are empty. Click a scenario under 'Simulate an incident' to start again."
