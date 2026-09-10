CREATE TABLE "customer_accounts" (
	"cust_account_id" bigint PRIMARY KEY NOT NULL,
	"party_id" bigint NOT NULL,
	"party_name" varchar(360) NOT NULL,
	"party_type" varchar(30) NOT NULL,
	"account_number" varchar(30) NOT NULL,
	"account_status" varchar(1) NOT NULL,
	"last_update_date" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customer_profiles" ALTER COLUMN "code" SET DATA TYPE varchar(30);--> statement-breakpoint
CREATE INDEX "idx_customer_accounts_party_id" ON "customer_accounts" USING btree ("party_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_customer_accounts_account_number" ON "customer_accounts" USING btree ("account_number");--> statement-breakpoint
CREATE INDEX "idx_customer_accounts_status" ON "customer_accounts" USING btree ("account_status");--> statement-breakpoint
ALTER TABLE "customer_profiles" ADD CONSTRAINT "customer_profiles_code_customer_accounts_account_number_fk" FOREIGN KEY ("code") REFERENCES "public"."customer_accounts"("account_number") ON DELETE no action ON UPDATE no action;