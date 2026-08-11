-- Attach the sync-events feed trigger to the new put_away_tasks table
-- (catalog: docs/backend/event-catalog.md). Hand-authored: drizzle-kit does
-- not emit triggers.
CREATE TRIGGER sync_events_notify AFTER INSERT OR UPDATE OR DELETE ON "put_away_tasks" FOR EACH ROW EXECUTE FUNCTION sync_events_notify();
