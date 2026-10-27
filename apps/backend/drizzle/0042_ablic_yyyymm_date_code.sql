-- ABLIC/SII $-reel labels carry the date code as YYYYMM (segment 5); decode
-- it to the week date code anchored on the 15th of the month
-- (spec 2026-10-27-scan-single-brand-wcl-item-no-derivation-design.md).
-- Guarded on the untouched (NULL) encoding so locally-edited profiles win.
UPDATE "supplier_profiles"
SET
  "date_code_encoding" = 'yyyymm_midmonth',
  "last_update_date" = now()
WHERE "supplier_code" IN ('70915', '84915')
  AND "date_code_encoding" IS NULL;
