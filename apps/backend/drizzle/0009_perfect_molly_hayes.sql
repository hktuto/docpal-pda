ALTER TABLE "picking_items" ADD COLUMN "line_id" bigint NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "picking_items" ADD COLUMN "line_number" integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "picking_items" ADD COLUMN "shipment_number" integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "picking_items" ADD COLUMN "status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "picking_items" ALTER COLUMN "line_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "picking_items" ALTER COLUMN "line_number" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "picking_items" ALTER COLUMN "shipment_number" DROP DEFAULT;
