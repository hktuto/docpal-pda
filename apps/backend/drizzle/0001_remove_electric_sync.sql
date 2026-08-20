-- Remove the Electric SQL sync subsystem.
-- The sync consumer (apps/backend/src/sync), sync_checkpoints table, and the
-- column-ownership guard rails are no longer used; upstream sync is performed
-- by an external service consuming the sync_events feed or writing through the
-- apply layer in apps/backend/src/db/ingest.ts.

DROP TABLE IF EXISTS "sync_checkpoints" CASCADE;

-- Revoke all privileges and default privileges before dropping the role.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM wms_sync_consumer;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM wms_sync_consumer;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM wms_sync_consumer;
ALTER DEFAULT PRIVILEGES FOR ROLE warehouse IN SCHEMA public REVOKE ALL ON TABLES FROM wms_sync_consumer;
ALTER DEFAULT PRIVILEGES FOR ROLE warehouse IN SCHEMA public REVOKE ALL ON SEQUENCES FROM wms_sync_consumer;
ALTER DEFAULT PRIVILEGES FOR ROLE warehouse IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM wms_sync_consumer;
DROP ROLE IF EXISTS wms_sync_consumer;

DROP FUNCTION IF EXISTS enforce_remote_owned_columns() CASCADE;
