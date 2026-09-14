ALTER TABLE "picking_orders" DROP CONSTRAINT "picking_orders_customer_code_customer_profiles_code_fk";
--> statement-breakpoint
ALTER TABLE "customer_profiles" ALTER COLUMN "rule" SET DATA TYPE jsonb USING (CASE WHEN rule IS NULL OR btrim(rule) = '' THEN NULL ELSE to_jsonb(rule) END);--> statement-breakpoint
ALTER TABLE "customer_profiles" ADD COLUMN "customers" jsonb DEFAULT '[]'::jsonb NOT NULL;