-- Flip receiving_invoice_items_cn.reported_mismatch to boolean, matching the
-- HK sibling (receiving_invoice_items), upstream sync, and 0/1 -> false/true
-- in the scan writes. DROP DEFAULT first — the integer default can't travel
-- with the type change. USING casts through ::text so this statement is safe
-- on both integer databases ('0'/'1') and environments the upstream already
-- created as boolean ('f'/'t' — those replay as a no-op conversion).
ALTER TABLE "receiving_invoice_items_cn" ALTER COLUMN "reported_mismatch" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "receiving_invoice_items_cn" ALTER COLUMN "reported_mismatch" TYPE boolean USING CASE WHEN "reported_mismatch"::text IN ('0','f','false') THEN false ELSE true END;--> statement-breakpoint
ALTER TABLE "receiving_invoice_items_cn" ALTER COLUMN "reported_mismatch" SET DEFAULT false;
