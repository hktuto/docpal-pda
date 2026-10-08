ALTER TABLE "supplier_profiles" ADD COLUMN IF NOT EXISTS "brands" text[];

-- KOA (supplier 32): segment 7 is the WCL item no — capture it as wclItemNo,
-- tolerate trailing segments + an optional trailing delimiter.
UPDATE "supplier_profiles"
SET "qr_template" = '^:(?<itemId>[^:]+):(?<subId>[^:]*):(?<qty>[^:]+):(?<ignore1>[^:]+):(?<lotCode>[^:]+):(?<serialNo>[^:]+):(?<wclItemNo>[^:]+)(?::[^:]*)*:?$'
WHERE "supplier_code" = '32'
  AND "qr_template" = '^:(?<itemId>[^:]+):(?<subId>[^:]*):(?<qty>[^:]+):(?<ignore1>[^:]+):(?<lotCode>[^:]+):(?<serialNo>[^:]+):(?<fullName>.+)$';

-- Brand mapping for the built-in templated profiles (scan pages try the
-- order-brand-matching templates first).
UPDATE "supplier_profiles" SET "brands" = '{KOA}' WHERE "supplier_code" = '32';
UPDATE "supplier_profiles" SET "brands" = '{NCC}' WHERE "supplier_code" = '23';
UPDATE "supplier_profiles" SET "brands" = '{COPAL,NIDEC}' WHERE "supplier_code" = '19915';
UPDATE "supplier_profiles" SET "brands" = '{SII}' WHERE "supplier_code" = '70915';
UPDATE "supplier_profiles" SET "brands" = '{ABLIC}' WHERE "supplier_code" = '84915';
UPDATE "supplier_profiles" SET "brands" = '{TE}' WHERE "supplier_code" = '15915';
UPDATE "supplier_profiles" SET "brands" = '{NDK}' WHERE "supplier_code" = '69915';
