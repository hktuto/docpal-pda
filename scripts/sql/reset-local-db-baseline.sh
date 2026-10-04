#!/usr/bin/env bash
# Reset warehouse_backend on the docker-compose Postgres to the baseline
# snapshot (scripts/sql/warehouse_backend_baseline.dump) — the local copy of
# the remote warehouse data captured 2026-10-04. Remote changes after the
# snapshot do not affect this baseline.
#
# Usage:
#   scripts/sql/reset-local-db-baseline.sh            restore the baseline
#   scripts/sql/reset-local-db-baseline.sh --snapshot re-capture the baseline
#                                                    from the CURRENT local DB
#
# DESTRUCTIVE (restore mode) — all current data in warehouse_backend is lost.
# Migrations newer than the snapshot auto-apply on next backend startup.
#
# Restore in two phases: schema first (FK constraints are created on empty
# tables, so no validation scan), then data with --disable-triggers (COPY
# bypasses the notify triggers and FK checks). Needed because the snapshot
# contains rows written past FK checks by the upstream sync's replication
# role (e.g. inventory_lots pointing at missing shelves), same as the remote —
# a single-pass restore would fail when post-data constraint creation scans
# those rows.
set -euo pipefail
cd "$(dirname "$0")/../.."

DUMP=scripts/sql/warehouse_backend_baseline.dump
PSQL="docker compose exec -T db psql -v ON_ERROR_STOP=1 -U warehouse"

if [[ "${1:-}" == "--snapshot" ]]; then
  docker compose exec -T db pg_dump -U warehouse -Fc warehouse_backend > "$DUMP.tmp"
  mv "$DUMP.tmp" "$DUMP"
  echo "reset-local-db-baseline: snapshot captured -> $DUMP"
  exit 0
fi

if [[ ! -s "$DUMP" ]]; then
  echo "reset-local-db-baseline: $DUMP missing — run with --snapshot first" >&2
  exit 1
fi

$PSQL -d warehouse \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='warehouse_backend' AND pid <> pg_backend_pid();" \
  -c "DROP DATABASE IF EXISTS warehouse_backend;" \
  -c "CREATE DATABASE warehouse_backend;"

docker compose exec -T db pg_restore -U warehouse -d warehouse_backend \
  --schema-only --no-owner --no-privileges --exit-on-error < "$DUMP"

docker compose exec -T db pg_restore -U warehouse -d warehouse_backend \
  --data-only --no-owner --no-privileges --disable-triggers --exit-on-error < "$DUMP"

echo "reset-local-db-baseline: done — warehouse_backend restored from $DUMP"
