#!/usr/bin/env bash
# Reset the local dev databases (needed after a migration-baseline rebuild).
# Drops and recreates warehouse_backend + warehouse_backend_test on the
# docker-compose Postgres, then re-applies migrations and re-seeds the dev DB.
# DESTRUCTIVE — all data in both databases is lost.
set -euo pipefail
cd "$(dirname "$0")/../.."

docker compose exec -T db psql -U warehouse -d warehouse \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname IN ('warehouse_backend','warehouse_backend_test') AND pid <> pg_backend_pid();" \
  -c "DROP DATABASE IF EXISTS warehouse_backend;" \
  -c "DROP DATABASE IF EXISTS warehouse_backend_test;" \
  -c "CREATE DATABASE warehouse_backend;" \
  -c "CREATE DATABASE warehouse_backend_test;"

pnpm --filter @warehouse/backend db:migrate
pnpm --filter @warehouse/backend db:seed

echo "reset-local-dbs: done — warehouse_backend migrated + seeded; warehouse_backend_test recreated (migrates on next test run)"
