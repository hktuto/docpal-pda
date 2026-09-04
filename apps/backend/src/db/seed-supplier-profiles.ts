// ---------------------------------------------------------------------------
// Built-in supplier QR label templates restored from the retired BVS system
// (BVSDB.dbo.RegPattern, Site_Code='WHHK', 2026-08-13 backup). Same content
// as scripts/sql/restore-supplier-profiles-whhk.sql — keep the two in sync
// (new_seed/check-seed-templates.mjs verifies the regexes are byte-identical).
// Verified against real BVSDB ScannedItem raws by new_seed/test-qr-templates.mjs.
//
// supplierCode is the ORACLE supplier code used on receiving_orders (the
// qr_template join goes receiving_orders.supplier_code -> suppliers.code ->
// supplier_profiles.supplier_code), NOT the text brand code on parts.
//
// barcodeTypes = PDA hardware-scanner symbology whitelist (xcheng display
// names, spec docs/superpowers/specs/2026-09-04-supplier-barcode-type-whitelist-design.md).
// undefined = no restriction. COPAL is left unrestricted (label symbology
// unconfirmed).
// ---------------------------------------------------------------------------

export interface BuiltinSupplierProfile {
  supplierCode: string;
  qrTemplate: string;
  qrType?: string;
  qtyEncoding?: string;
  barcodeTypes?: string[];
  remark: string;
}

// KOA: colon-delimited PDF417 reel label, e.g.
//   :RK73H1ETTP1001F::54:X:1114T232:S606:KOA+RK73H1ETTP 1001F::::
const KOA_TEMPLATE = String.raw`^:(?<itemId>[^:]+):(?<subId>[^:]*):(?<qty>[^:]+):(?<ignore1>[^:]+):(?<lotCode>[^:]+):(?<serialNo>[^:]+):(?<fullName>.+)$`;

// NCC (Chemi-Con): fixed-width ITF reel barcode, all digits.
//   28-char: itemId(6) flag(3) lot(7) pack(3) qty(5) serial(4)
//   32-char (NCC_KTD): itemId(10) flag(3) lot(7) pack(2) qty(6) serial(4)
// itemId is the numeric NCC item code, NOT the MPN — the barcode carries no
// MPN; the old system mapped code -> MPN via dbo.RegItem (no equivalent here).
const NCC_TEMPLATE = String.raw`^(?=.{28}$|.{32}$)(?<itemId>\d{6,10})\d{3}(?<lotCode>\d{7})\d{3}(?<qty>\d{5,6})(?<serialNo>\d{4})$`;

// COPAL: fixed-width 111-char reel label, e.g.
//   234101510021                CJS-1200TB1                             2000  2071  C6E      605220557MMJ805615383C
// For OHM-spec trimmer parts the resistance code (103 of CT-94EW103) lands in
// the resCode group and is dropped by parseQrRaw — those parts won't match.
const COPAL_TEMPLATE = String.raw`^\d{12}\s+(?<itemId>[A-Z0-9][A-Z0-9 ./-]*?)(?:\s{2,}\d{1,2}K\s+OHM\((?<resCode>\d+)\))?\s+(?<qty>\d+)\s+\d+\s+\S+\s+(?<serialNo>\S+).*$`;

// SII/ABLIC: $-delimited reel QR, e.g.
//   1$S-5743NBH1A-M3T4U$3000$VM3F6XA1761-0367$S-5743NBH1A-M3T4U$202607$67352039027
// fields: 1 $ MPN $ qty $ lot $ MPN-repeat $ yyyymm $ serial.
const SII_TEMPLATE = String.raw`^1\$[^$]+\$(?<qty>\d+)\$(?<lotCode>[^$]+)\$(?<itemId>[^$]+)\$(?<dateCode>\d{6})\$(?<serialNo>[^$]+?)\s*$`;

// TE Connectivity: MH10.8.2 DataMatrix (GS=\x1d, RS=\x1e, EOT=\x04):
//   [)>RS06 GS LT... GS PN1903415-1 GS RVG GS QT1584 GS PO... GS BT... GS BX3 GS DC26055 RS EOT
const TE_TEMPLATE = String.raw`^\[\)>\x1e06\x1dLT(?<serialNo>[^\x1d\x1e\x04]+)\x1dPN(?<itemId>[^\x1d\x1e\x04]+)\x1dRV[^\x1d]*\x1dQT(?<qty>\d+)\x1dPO[^\x1d]*\x1dBT(?<lotCode>[^\x1d\x1e\x04]+)\x1dBX[^\x1d]+\x1dDC(?<dateCode>[^\x1d\x1e\x04]+)[\x1e\x04]*$`;

// NDK: MH10.8.2 QR, e.g.
//   [)>RS06 GS PWEL-EXS00A-CS16279 GS 1TL5101564 GS Q9000 GS 1PEXS00A-CS16279 RS EOT
const NDK_TEMPLATE = String.raw`^\[\)>\x1e06\x1dP(?<custPn>[^\x1d\x1e\x04]+)\x1d1T(?<serialNo>[^\x1d\x1e\x04]+)\x1dQ(?<qty>\d+)\x1d1P(?<itemId>[^\x1d\x1e\x04]+)[\x1e\x04]*$`;

export const builtinSupplierProfiles: BuiltinSupplierProfile[] = [
  {
    supplierCode: "32", // KOA ELECTRONICS (HK) LTD
    qrTemplate: KOA_TEMPLATE,
    qrType: "pdf417",
    qtyEncoding: "koa_zeros",
    barcodeTypes: ["PDF417"],
    remark:
      "Restored from BVSDB RegPattern Id=161 (WHHK), 2026-08-13 backup; folds Id=192 KOA_NOLOTNO / Id=193 KOA_NOTKEY. Verified vs 96 real ScannedItem raws.",
  },
  {
    supplierCode: "23", // HONGKONG CHEMI-CON LTD (NCC)
    qrTemplate: NCC_TEMPLATE,
    qrType: "itf",
    barcodeTypes: ["ITF25"],
    remark:
      "Restored from BVSDB RegPattern Id=165 (WHHK), 2026-08-13 backup; folds Id=167 NCC+KOA and Id=195 NCC_KTD (32-char). itemId is the NCC numeric item code, not the MPN. Verified vs 122 real ScannedItem raws.",
  },
  {
    supplierCode: "19915", // NIDEC(H.K.)CO.,LIMITED (COPAL)
    qrTemplate: COPAL_TEMPLATE,
    remark:
      "Restored from BVSDB RegPattern Id=156 (WHHK), 2026-08-13 backup. OHM-spec parts (resCode group) will not auto-match parts.part_no. Verified vs 53 real ScannedItem raws.",
  },
  {
    supplierCode: "70915", // SII SEMICONDUCTOR HONG KONG LIMITED
    qrTemplate: SII_TEMPLATE,
    qrType: "qr",
    barcodeTypes: ["QR CODE"],
    remark:
      "Restored from BVSDB RegPattern Id=173 (WHHK), 2026-08-13 backup. SII renamed ABLIC — same template also attached to supplier 84915. Verified vs 114 real ScannedItem raws.",
  },
  {
    supplierCode: "84915", // ABLIC HONG KONG LTD.
    qrTemplate: SII_TEMPLATE,
    qrType: "qr",
    barcodeTypes: ["QR CODE"],
    remark:
      "Restored from BVSDB RegPattern Id=173 (WHHK), 2026-08-13 backup — same template as supplier 70915 (SII renamed ABLIC). Verified vs 114 real ScannedItem raws.",
  },
  {
    supplierCode: "15915", // TE CONNECTIVITY HK LIMITED
    qrTemplate: TE_TEMPLATE,
    qrType: "datamatrix",
    barcodeTypes: ["DATA MATRIX"],
    remark:
      "Restored from BVSDB RegPattern Id=194 (WHHK), 2026-08-13 backup. Photo-verified only (no BVSDB scans); parts master may carry prefixed numbers (AMP(1903415-1)).",
  },
  {
    supplierCode: "69915", // NDK ELECTRONICS (HK) LTD.
    qrTemplate: NDK_TEMPLATE,
    qrType: "qr",
    barcodeTypes: ["QR CODE"],
    remark:
      "Restored from BVSDB RegPattern Id=170 NDK_16M (WHHK), 2026-08-13 backup. Photo-verified only; partial 1P values (STD-CSR-3) will not match composed parts.part_no.",
  },
];
