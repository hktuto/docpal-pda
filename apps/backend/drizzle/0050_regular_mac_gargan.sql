-- receiving_invoice_items_cn.packing_list_num — the upstream sync service
-- added this column itself (hand-applied DDL, same pattern as the early CN
-- tables); IF NOT EXISTS keeps the migration a no-op on those databases.
ALTER TABLE "receiving_invoice_items_cn" ADD COLUMN IF NOT EXISTS "packing_list_num" varchar(255);
