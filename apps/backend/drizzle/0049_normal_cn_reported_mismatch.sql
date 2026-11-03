-- Normalize receiving_invoice_items_cn.reported_mismatch to integer (the
-- schema's declared type). Environments that got the CN table from an early
-- hand-applied DDL have it as boolean; the 0/1 scan writes then fail with
-- 42804. DROP DEFAULT first — a boolean default can't cast to integer.
ALTER TABLE "receiving_invoice_items_cn" ALTER COLUMN "reported_mismatch" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "receiving_invoice_items_cn" ALTER COLUMN "reported_mismatch" TYPE integer USING "reported_mismatch"::integer;--> statement-breakpoint
ALTER TABLE "receiving_invoice_items_cn" ALTER COLUMN "reported_mismatch" SET DEFAULT 0;
