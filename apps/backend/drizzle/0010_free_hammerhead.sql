CREATE TABLE "sync_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"event_data" jsonb NOT NULL,
	"created_date" timestamp NOT NULL,
	"last_update_date" timestamp NOT NULL
);
--> statement-breakpoint
-- Dedicated role for the external sync service (idempotent; roles are
-- cluster-global, so this no-ops on test/secondary databases).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'warehouse_sync') THEN
    CREATE ROLE warehouse_sync LOGIN PASSWORD 'warehouse_sync';
  END IF;
END
$$;
--> statement-breakpoint
-- The service reads events and writes replicated rows into the business tables.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO warehouse_sync;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE warehouse IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO warehouse_sync;
--> statement-breakpoint
-- Table-change feed trigger (catalog: docs/backend/event-catalog.md).
-- Whitelist: only changes committed by the backend's own role ('warehouse')
-- are recorded — the sync service ('warehouse_sync'), manual sessions, and
-- any other writer are skipped, breaking the circular-event loop.
-- 'app.sync_events_off' lets seed/reset paths suppress the flood.
CREATE OR REPLACE FUNCTION sync_events_notify() RETURNS trigger AS $$
BEGIN
  IF current_user <> 'warehouse' THEN RETURN NULL; END IF;
  IF current_setting('app.sync_events_off', true) = '1' THEN RETURN NULL; END IF;
  INSERT INTO sync_events (event_type, event_data, created_date, last_update_date)
  VALUES (
    TG_TABLE_NAME || '.' || lower(TG_OP),
    jsonb_build_object(
      'table', TG_TABLE_NAME,
      'action', TG_OP,
      'new', CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END,
      'old', CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END
    ),
    now(),
    now()
  );
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER sync_events_notify AFTER INSERT OR UPDATE OR DELETE ON "users" FOR EACH ROW EXECUTE FUNCTION sync_events_notify();
--> statement-breakpoint
CREATE TRIGGER sync_events_notify AFTER INSERT OR UPDATE OR DELETE ON "user_groups" FOR EACH ROW EXECUTE FUNCTION sync_events_notify();
--> statement-breakpoint
CREATE TRIGGER sync_events_notify AFTER INSERT OR UPDATE OR DELETE ON "user_group_members" FOR EACH ROW EXECUTE FUNCTION sync_events_notify();
--> statement-breakpoint
CREATE TRIGGER sync_events_notify AFTER INSERT OR UPDATE OR DELETE ON "suppliers" FOR EACH ROW EXECUTE FUNCTION sync_events_notify();
--> statement-breakpoint
CREATE TRIGGER sync_events_notify AFTER INSERT OR UPDATE OR DELETE ON "supplier_profiles" FOR EACH ROW EXECUTE FUNCTION sync_events_notify();
--> statement-breakpoint
CREATE TRIGGER sync_events_notify AFTER INSERT OR UPDATE OR DELETE ON "parts" FOR EACH ROW EXECUTE FUNCTION sync_events_notify();
--> statement-breakpoint
CREATE TRIGGER sync_events_notify AFTER INSERT OR UPDATE OR DELETE ON "shelves" FOR EACH ROW EXECUTE FUNCTION sync_events_notify();
--> statement-breakpoint
CREATE TRIGGER sync_events_notify AFTER INSERT OR UPDATE OR DELETE ON "country_list" FOR EACH ROW EXECUTE FUNCTION sync_events_notify();
--> statement-breakpoint
CREATE TRIGGER sync_events_notify AFTER INSERT OR UPDATE OR DELETE ON "box_size_list" FOR EACH ROW EXECUTE FUNCTION sync_events_notify();
--> statement-breakpoint
CREATE TRIGGER sync_events_notify AFTER INSERT OR UPDATE OR DELETE ON "net_weight_formula" FOR EACH ROW EXECUTE FUNCTION sync_events_notify();
--> statement-breakpoint
CREATE TRIGGER sync_events_notify AFTER INSERT OR UPDATE OR DELETE ON "customer_profiles" FOR EACH ROW EXECUTE FUNCTION sync_events_notify();
--> statement-breakpoint
CREATE TRIGGER sync_events_notify AFTER INSERT OR UPDATE OR DELETE ON "sub_inventories" FOR EACH ROW EXECUTE FUNCTION sync_events_notify();
--> statement-breakpoint
CREATE TRIGGER sync_events_notify AFTER INSERT OR UPDATE OR DELETE ON "sub_inventory_share_members" FOR EACH ROW EXECUTE FUNCTION sync_events_notify();
--> statement-breakpoint
CREATE TRIGGER sync_events_notify AFTER INSERT OR UPDATE OR DELETE ON "receiving_orders" FOR EACH ROW EXECUTE FUNCTION sync_events_notify();
--> statement-breakpoint
CREATE TRIGGER sync_events_notify AFTER INSERT OR UPDATE OR DELETE ON "receiving_invoices" FOR EACH ROW EXECUTE FUNCTION sync_events_notify();
--> statement-breakpoint
CREATE TRIGGER sync_events_notify AFTER INSERT OR UPDATE OR DELETE ON "receiving_invoice_items" FOR EACH ROW EXECUTE FUNCTION sync_events_notify();
--> statement-breakpoint
CREATE TRIGGER sync_events_notify AFTER INSERT OR UPDATE OR DELETE ON "receiving_scan_labels" FOR EACH ROW EXECUTE FUNCTION sync_events_notify();
--> statement-breakpoint
CREATE TRIGGER sync_events_notify AFTER INSERT OR UPDATE OR DELETE ON "picking_orders" FOR EACH ROW EXECUTE FUNCTION sync_events_notify();
--> statement-breakpoint
CREATE TRIGGER sync_events_notify AFTER INSERT OR UPDATE OR DELETE ON "picking_items" FOR EACH ROW EXECUTE FUNCTION sync_events_notify();
--> statement-breakpoint
CREATE TRIGGER sync_events_notify AFTER INSERT OR UPDATE OR DELETE ON "picking_packages" FOR EACH ROW EXECUTE FUNCTION sync_events_notify();
--> statement-breakpoint
CREATE TRIGGER sync_events_notify AFTER INSERT OR UPDATE OR DELETE ON "shipping_boxes" FOR EACH ROW EXECUTE FUNCTION sync_events_notify();
--> statement-breakpoint
CREATE TRIGGER sync_events_notify AFTER INSERT OR UPDATE OR DELETE ON "shipping_box_items" FOR EACH ROW EXECUTE FUNCTION sync_events_notify();
--> statement-breakpoint
CREATE TRIGGER sync_events_notify AFTER INSERT OR UPDATE OR DELETE ON "measuring_tasks" FOR EACH ROW EXECUTE FUNCTION sync_events_notify();
--> statement-breakpoint
CREATE TRIGGER sync_events_notify AFTER INSERT OR UPDATE OR DELETE ON "verify_tasks" FOR EACH ROW EXECUTE FUNCTION sync_events_notify();
--> statement-breakpoint
CREATE TRIGGER sync_events_notify AFTER INSERT OR UPDATE OR DELETE ON "inventory_lots" FOR EACH ROW EXECUTE FUNCTION sync_events_notify();
--> statement-breakpoint
CREATE TRIGGER sync_events_notify AFTER INSERT OR UPDATE OR DELETE ON "inventory_lot_sources" FOR EACH ROW EXECUTE FUNCTION sync_events_notify();
--> statement-breakpoint
CREATE TRIGGER sync_events_notify AFTER INSERT OR UPDATE OR DELETE ON "shelf_boxes" FOR EACH ROW EXECUTE FUNCTION sync_events_notify();
--> statement-breakpoint
CREATE TRIGGER sync_events_notify AFTER INSERT OR UPDATE OR DELETE ON "shelf_box_items" FOR EACH ROW EXECUTE FUNCTION sync_events_notify();
--> statement-breakpoint
CREATE TRIGGER sync_events_notify AFTER INSERT OR UPDATE OR DELETE ON "allocations" FOR EACH ROW EXECUTE FUNCTION sync_events_notify();
--> statement-breakpoint
CREATE TRIGGER sync_events_notify AFTER INSERT OR UPDATE OR DELETE ON "goods_verify_tasks" FOR EACH ROW EXECUTE FUNCTION sync_events_notify();
