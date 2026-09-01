-- ---------------------------------------------------------------------------
-- Restore WHHK supplier label-parsing profiles from the retired BVS system
-- (BVSDB.dbo.RegPattern, Site_Code='WHHK', 2026-08-13 backup) into the new
-- supplier_profiles.qr_template format (JS regex with named groups, executed
-- by apps/backend/src/db/scanParse.ts parseQrRaw).
--
-- 10 old RegPattern rows collapse to 6 supplier_codes:
--   KOA   <- Id=161 (canonical 'Primary Key' row); Id=192 KOA_NOLOTNO and
--            Id=193 KOA_NOTKEY are subsets of the same label layout.
--   NCC   <- Id=165 (canonical) + Id=167 NCC+KOA (identical 28-char layout)
--            + Id=195 NCC_KTD (32-char, 10-digit item code; folded into the
--            same regex via length lookahead + greedy item code).
--   COPAL <- Id=156 (fixed-width 111-char reel label)
--   SII   <- Id=173 ($-delimited reel QR)
--   TE    <- Id=194 (MH10.8.2 DataMatrix; verified from label photos)
--   NDK   <- Id=170 (NDK_16M; modern MH10.8.2 QR verified from label photos)
--
-- Every template is verified against real scans exported from
-- BVSDB.dbo.ScannedItem (or photo-decoded raws for TE/NDK) by
-- new_seed/test-qr-templates.mjs — run `node new_seed/test-qr-templates.mjs`.
--
-- Idempotent: upserts on supplier_code. supplier_code FK -> suppliers.code;
-- all six codes exist in the seeded suppliers table (KOA seeded explicitly,
-- NCC/COPAL/SII/TE/NDK auto-created from the Oracle parts master). qr_template_config
-- is intentionally left untouched/NULL (hand-written legacy templates).
-- ---------------------------------------------------------------------------

BEGIN;

INSERT INTO supplier_profiles (id, supplier_code, name, qr_template, qr_template_config, qr_type, qty_encoding, remark)
VALUES
  -- KOA: colon-delimited PDF417 reel label, e.g.
  --   :RK73H1ETTP1001F::54:X:1114T232:S606:KOA+RK73H1ETTP 1001F::::
  -- itemId = field 1 MPN (new-system convention, identical to the seeded KOA
  -- template; the old system keyed on field 7 customer P/N instead).
  -- qty = field 3, koa_zeros ("54" -> 50000). Verified: 96/96 real scans.
  (
    '00000000-0000-7000-8000-000000009001', 'KOA', NULL,
    $re$^:(?<itemId>[^:]+):(?<subId>[^:]*):(?<qty>[^:]+):(?<ignore1>[^:]+):(?<lotCode>[^:]+):(?<serialNo>[^:]+):(?<fullName>.+)$$re$,
    NULL, 'pdf417', 'koa_zeros',
    'Restored from BVSDB RegPattern Id=161 (WHHK), 2026-08-13 backup; folds Id=192 KOA_NOLOTNO / Id=193 KOA_NOTKEY (same layout, fewer captured fields). Identical to the seeded KOA template. Verified vs 96 real ScannedItem raws.'
  ),

  -- NCC: fixed-width ITF reel barcode, all digits.
  --   28-char: itemId(6) flag(3) lot(7) pack(3) qty(5) serial(4)  e.g. 2648786070782706002005000414 (qty 500)
  --   32-char (NCC_KTD, TND/TNR varistors): itemId(10) flag(3) lot(7) pack(2) qty(6) serial(4)
  --   e.g. 06711422706071038400210015000024 (qty 1500)
  -- NOTE: itemId is the numeric NCC item code, NOT the full MPN — the barcode
  -- carries no MPN. The old system resolved code -> MPN via dbo.RegItem
  -- (Secondary_Key -> Search_Key, e.g. 264878 -> EKZN101ETD271MK30S-R); the new
  -- system has no such lookup, so receiving-match relies on the upstream
  -- invoice lines carrying this code (or a future code->MPN mapping table).
  -- Verified: 119/122 real scans parse exactly (2 warnings: one label-qty vs
  -- recorded-qty discrepancy in the old data, one '000000' placeholder code).
  (
    '00000000-0000-7000-8000-000000009002', 'NCC', NULL,
    $re$^(?=.{28}$|.{32}$)(?<itemId>\d{6,10})\d{3}(?<lotCode>\d{7})\d{3}(?<qty>\d{5,6})(?<serialNo>\d{4})$$re$,
    NULL, 'itf', NULL,
    'Restored from BVSDB RegPattern Id=165 (WHHK), 2026-08-13 backup; folds Id=167 NCC+KOA (identical layout) and Id=195 NCC_KTD (32-char, 10-digit item code). itemId is the NCC numeric item code — old system mapped it to the MPN via RegItem; no equivalent lookup exists in the new system. Verified vs 122 real ScannedItem raws.'
  ),

  -- COPAL: fixed-width 111-char reel label, e.g.
  --   234101510021                CJS-1200TB1                             2000  2071  C6E      605220557MMJ805615383C
  --   202661004111                CT-9  4EW           10K  OHM(103)       100   646   C6F      606220290PPZ205648146C
  -- itemId = printed part name (whitespace-collapsed by normalizePartNo ->
  -- e.g. CJS-1200TB1, SD-2011, CT-94EW). For OHM-spec trimmer parts the
  -- resistance code (103 -> CT-94EW103 in the parts master) lands in the
  -- separate resCode group and is DROPPED by parseQrRaw — a regex named group
  -- cannot concatenate non-adjacent substrings, so OHM parts will not match
  -- parts.part_no directly (the old system never resolved these either:
  -- recorded Part_Num is empty for all COPAL scans in BVSDB).
  -- Verified: 53/53 distinct real scans (qty + structure).
  (
    '00000000-0000-7000-8000-000000009003', 'COPAL', NULL,
    $re$^\d{12}\s+(?<itemId>[A-Z0-9][A-Z0-9 ./-]*?)(?:\s{2,}\d{1,2}K\s+OHM\((?<resCode>\d+)\))?\s+(?<qty>\d+)\s+\d+\s+\S+\s+(?<serialNo>\S+).*$$re$,
    NULL, NULL, NULL,
    'Restored from BVSDB RegPattern Id=156 (WHHK), 2026-08-13 backup. Fixed-width reel label; the old .NET conditional regex (?(.+ohm.+)...|...) was adapted to an optional OHM group (JS has no conditionals). resCode (e.g. 103 of CT-94EW103) is captured but dropped by the parser — OHM-spec COPAL parts will not auto-match parts.part_no. Verified vs 53 real ScannedItem raws.'
  ),

  -- SII (ABLIC): $-delimited reel QR, e.g.
  --   1$S-5743NBH1A-M3T4U$3000$VM3F6XA1761-0367$S-5743NBH1A-M3T4U$202607$67352039027
  -- fields: 1 $ MPN $ qty $ lot $ MPN-repeat $ yyyymm $ serial.
  -- itemId = field 4 (the old Primary_Key); field 1 is the same MPN except on
  -- U3/U4 tape-variant labels. dateCode = field 5 (YYYYMM).
  -- NOTE: the scanned parts exist in the parts master under brand 'ABLIC'
  -- (SII was renamed ABLIC) — consider duplicating this template under
  -- supplier_code 'ABLIC' if receiving orders reference that code.
  -- Verified: 114/114 real scans (itemId == recorded Part_Num, qty match).
  (
    '00000000-0000-7000-8000-000000009004', 'SII', NULL,
    $re$^1\$[^$]+\$(?<qty>\d+)\$(?<lotCode>[^$]+)\$(?<itemId>[^$]+)\$(?<dateCode>\d{6})\$(?<serialNo>[^$]+?)\s*$$re$,
    NULL, 'qr', NULL,
    'Restored from BVSDB RegPattern Id=173 (WHHK), 2026-08-13 backup. itemId = field 4 (old Primary_Key; field 1 carries the same MPN except U3/U4 variants). Scanned parts are under brand ABLIC in the parts master (SII renamed ABLIC) — duplicate this template under ABLIC if needed. Verified vs 114 real ScannedItem raws.'
  ),

  -- TE Connectivity: MH10.8.2 DataMatrix, e.g. (GS=\x1d, RS=\x1e, EOT=\x04)
  --   [)>RS06 GS LT3S0852E2072351 GS PN1903415-1 GS RVG GS QT1584 GS PO200233391894 GS BT26055D GS BX3 GS DC26055 RS EOT
  -- itemId = PN (supplier part no), qty = QT, lotCode = BT (batch),
  -- serialNo = LT (lot trace no), dateCode = DC (YYWWD).
  -- No WHHK scans exist in BVSDB for TE — verified against 5 raws decoded
  -- from label photos (docs/Supplier Sample Documents/TE -MCI/TE-01..05).
  -- NOTE: TE part numbers in the parts master may carry prefixes
  -- (e.g. 'AMP(1903415-1)') that the PN value does not — matching must be
  -- confirmed against real receiving lines.
  (
    '00000000-0000-7000-8000-000000009005', 'TE', NULL,
    $re$^\[\)>\x1e06\x1dLT(?<serialNo>[^\x1d\x1e\x04]+)\x1dPN(?<itemId>[^\x1d\x1e\x04]+)\x1dRV[^\x1d]*\x1dQT(?<qty>\d+)\x1dPO[^\x1d]*\x1dBT(?<lotCode>[^\x1d\x1e\x04]+)\x1dBX[^\x1d]+\x1dDC(?<dateCode>[^\x1d\x1e\x04]+)[\x1e\x04]*$$re$,
    NULL, 'datamatrix', NULL,
    'Restored from BVSDB RegPattern Id=194 (WHHK), 2026-08-13 backup. No TE scans in BVSDB — template verified against 5 DataMatrix raws decoded from label photos TE-01..05 (MH10.8.2: LT/PN/RV/QT/PO/BT/BX/DC). Parts master may store prefixed numbers (AMP(1903415-1)) — confirm matching on real receiving lines.'
  ),

  -- NDK: MH10.8.2 QR on the reel/box label, e.g.
  --   [)>RS06 GS PWEL-EXS00A-CS16279 GS 1TL5101564 GS Q9000 GS 1PEXS00A-CS16279 RS EOT
  -- itemId = 1P (NDK P/N), qty = Q, serialNo = 1T (label control number),
  -- custPn = P (customer part number, ignored by the parser).
  -- The old NDK_16M row (Id=170) targeted an older label revision (delimiter
  -- 'T'/'Q' spec, 17-char fixed key, e.g. NX3225SC-16.000M-STD-CRS-1); no
  -- scans of either revision exist in BVSDB. Verified against 2 raws decoded
  -- from label photos (NDK-01/02). NOTE: some labels carry only a partial P/N
  -- in 1P (e.g. 'STD-CSR-3' where parts.part_no is the composed
  -- 'NX3225SA-12.000M-STD-CSR-3') — those will not auto-match.
  (
    '00000000-0000-7000-8000-000000009006', 'NDK', NULL,
    $re$^\[\)>\x1e06\x1dP(?<custPn>[^\x1d\x1e\x04]+)\x1d1T(?<serialNo>[^\x1d\x1e\x04]+)\x1dQ(?<qty>\d+)\x1d1P(?<itemId>[^\x1d\x1e\x04]+)[\x1e\x04]*$$re$,
    NULL, 'qr', NULL,
    'Restored from BVSDB RegPattern Id=170 NDK_16M (WHHK), 2026-08-13 backup. No NDK scans in BVSDB; old row targeted an older label revision. Template matches the current MH10.8.2 QR, verified against 2 raws decoded from label photos NDK-01/02. Partial 1P values (STD-CSR-3) will not match composed parts.part_no (NX3225SA-12.000M-STD-CSR-3).'
  )
ON CONFLICT (supplier_code) DO UPDATE SET
  name = EXCLUDED.name,
  qr_template = EXCLUDED.qr_template,
  qr_type = EXCLUDED.qr_type,
  qty_encoding = EXCLUDED.qty_encoding,
  remark = EXCLUDED.remark,
  last_update_date = now();

COMMIT;

-- Verification: expect 6 rows.
SELECT supplier_code, qr_type, qty_encoding, left(qr_template, 60) AS template_head
FROM supplier_profiles
WHERE supplier_code IN ('KOA', 'NCC', 'COPAL', 'SII', 'TE', 'NDK')
ORDER BY supplier_code;
