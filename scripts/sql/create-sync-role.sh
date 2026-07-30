#!/bin/sh
# First-init role bootstrap for the external sync service. Mounted into
# /docker-entrypoint-initdb.d by docker-compose.prod.yml — runs once, only on
# an empty data dir. Backend migration 0010 repeats the same CREATE ROLE
# (idempotent) plus the table grants, so existing volumes are covered there.
set -e

psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<-SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'warehouse_sync') THEN
    CREATE ROLE warehouse_sync LOGIN PASSWORD '${SYNC_DB_PASSWORD:-warehouse_sync}';
  END IF;
END
\$\$;
SQL

echo "create-sync-role: warehouse_sync role ensured"
