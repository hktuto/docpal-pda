-- BUG-040: COPAL/NIDEC models print parentheses (e.g. CHS-04TB(34),
-- DP1120Z(COLORCAP) — 22 names in the parts master). The itemId character
-- class excluded ( ) so those reels never matched the template.
-- Guarded on the pre-fix regex so locally-edited profiles win.
UPDATE "supplier_profiles"
SET
  "qr_template" = '^\d{12}\s+(?<itemId>[A-Z0-9][A-Z0-9 ./()-]*?)(?:\s{2,}\d{1,2})?(?:\s{2,}\d+K\s+[Oo][Hh][Mm]\((?<resCode>\d+)\))?\s+(?<qty>\d+)\s+\d+\s+\S+\s+(?<serialNo>(?<lotCode>\d{5})?\S*).*$',
  "last_update_date" = now()
WHERE "supplier_code" = '19915'
  AND "qr_template" = '^\d{12}\s+(?<itemId>[A-Z0-9][A-Z0-9 ./-]*?)(?:\s{2,}\d{1,2})?(?:\s{2,}\d+K\s+[Oo][Hh][Mm]\((?<resCode>\d+)\))?\s+(?<qty>\d+)\s+\d+\s+\S+\s+(?<serialNo>(?<lotCode>\d{5})?\S*).*$';
