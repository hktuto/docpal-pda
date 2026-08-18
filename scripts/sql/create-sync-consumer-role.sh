#!/bin/sh
# First-init role bootstrap for the Electric sync consumer. Mounted into
# /docker-entrypoint-initdb.d by docker-compose.prod.yml — runs once, only on
# an empty data dir. Migration 0015 repeats the same CREATE ROLE (idempotent,
# default password) plus the table grants, so existing volumes are covered
# there; this script just sets the production password early.
set -e

psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<-SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'wms_sync_consumer') THEN
    CREATE ROLE wms_sync_consumer LOGIN PASSWORD '${SYNC_CONSUMER_DB_PASSWORD:-wms_sync_consumer}';
  ELSE
    ALTER ROLE wms_sync_consumer WITH PASSWORD '${SYNC_CONSUMER_DB_PASSWORD:-wms_sync_consumer}';
  END IF;
END
\$\$;
SQL

echo "create-sync-consumer-role: wms_sync_consumer role ensured"
