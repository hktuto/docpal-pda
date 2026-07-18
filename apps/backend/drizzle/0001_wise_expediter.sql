CREATE TABLE "supplier_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"supplier_code" text NOT NULL,
	"name" text,
	"short_name" text,
	"qr_template" text,
	"qty_encoding" text,
	"remark" text,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "supplier_profiles_supplier_code_unique" UNIQUE("supplier_code")
);
--> statement-breakpoint
ALTER TABLE "supplier_profiles" ADD CONSTRAINT "supplier_profiles_supplier_code_suppliers_code_fk" FOREIGN KEY ("supplier_code") REFERENCES "public"."suppliers"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppliers" DROP COLUMN "short_name";