# Extraction Review & Curation Report

Generated from `scripts/seed-extraction-summary.json` after re-running `node scripts/extract-seed-data.mjs`.

---

## 1. Supplier inventory

| # | Supplier name | Code | Docs | Summary |
|---|----------------|------|------|---------|
| 1 | ABLIC | `ABLIC` | 2 PDFs | Invoice 1080082369 + packing list 1084280081; 36,000 ICs (5 part numbers). |
| 2 | DAITO | `DAITO` | 1 PDF | Invoice/packing list INV-25-0422P; 14,000 fuses (2 part numbers). |
| 3 | DEXERIALS -MCI | `DEXERI` | 1 PDF | AWB/packing doc; extracted text empty/unreadable. |
| 4 | DIOTEC | `DIOTEC` | 2 PDFs | Invoice RE52600142 + packing list DTOU26050025; ~404,400 diodes (5 part numbers). |
| 5 | HINODE -MCI | `HINODE` | 1 PDF | Invoice; extracted text empty. |
| 6 | ICHAUS -MCI | `ICHAUS` | 38 PDFs | `fedex.pdf`/`inv.pdf` labels unreadable; 36 delivery-note invoices R324303–R324338 with clear single-part lines. |
| 7 | IK Semicon | `IK` | 1 PDF | Commercial invoice/packing list IKC260429E; 14,000 ICs (2 part numbers). |
| 8 | KOA | `KOA` | 4 docs | CSV/PDF/XLSX invoice + PDF packing list; 425,000+ resistors (many part numbers). |
| 9 | KYOCERA -MCI | `KYOCER` | 2 PDFs | Invoice/packing list C227916; 12,000 crystals (1 part number). |
| 10 | M-TRON | `M` | 2 PDFs | Both PDFs extracted as empty. |
| 11 | MINEBEAMITSUMI -MCI | `MINEBE` | 2 PDFs | Invoice/packing list 4102291257; 2 motor components (1 part number). |
| 12 | MMC | `MMC` | 5 PDFs | 2 readable invoice/packing-list pairs (JMY 00422-25HWC) + 3 empty PDFs; 4,000 thermistors. |
| 13 | NCC | `NCC` | 2 PDFs | Invoice/packing list HCC0780458; capacitors and varistors (5+ part numbers). |
| 14 | NDK | `NDK` | 1 PDF | Invoice/packing list 14519; 5,000 crystal units (1 part number). |
| 15 | NIDEC | `NIDEC` | 3 docs | XLSX packing list H2-07865A has 1 line item; 2 accompanying PDFs are empty. |
| 16 | NITSUKO | `NITSUK` | 1 PDF | Packing list; extracted text empty. |
| 17 | OKAYA -MCI | `OKAYA` | 1 PDF | Invoice/packing list SI25002441; 22,000 across-the-line capacitors (2 part numbers). |
| 18 | SEIKO -MCI & MCE | `SEIKO` | 2 PDFs | Invoice empty; packing list SIHPL20260604 has 1,623 crystals (3 part numbers). |
| 19 | SEMIKRON -MCI | `SEMIKR` | 2 PDFs | Invoice 2414HK000970 + packing list 2414DE020665; 1,008 thyristor modules. |
| 20 | SEMITEC | `SEMITE` | 1 PDF | Invoice; extracted text empty. |
| 21 | Shindengen | `SHINDE` | 1 PDF | Invoice/packing list SSE0002181; 18,000 diodes (5 part numbers). |
| 22 | SUMITOMO -MCI | `SUMITO` | 1 PDF | Invoice IV2602616; 2 cable lines measured in kilometres. |
| 23 | TE -MCI | `TE` | 2 PDFs | Two export invoices; 2 terminal/faston lines. |
| 24 | VINA -MCE | `VINA` | 1 PDF | Invoice/packing list VNHWS260417-001; 14,535 supercapacitors (1 part number). |
| 25 | YAMAICHI -MCE | `YAMAIC` | 1 PDF | Invoice/packing list doc20260605; 10,000 connectors (1 part number). |
| 26 | YAMAICHI -MCI | `YAMA1` | 1 PDF | Invoice/packing list doc20251201; extracted text empty. |

---

## Guidance notes for seed data

### COO normalization

Full country names are normalized to 2-letter codes in the seed:

| Full name | Code |
|-----------|------|
| China | CN |
| Japan | JP |
| India | IN |
| Germany | DE |
| Republic of Korea | KR |
| Malaysia | MY |
| Indonesia | ID |
| USA | US |

### Country of warehousing (COW)

For all receiving items and shelf lots, use `cow: "USA"` as the default (consistent with existing seed).

### Receiving-order status

Recommend the first two receiving orders (KOA and ABLIC) be seeded with `status: "in_hand"` and the third (DIOTEC) with `status: "pending"` so the receiving list shows actionable work.

## 2. Recommended receiving-order suppliers

These three suppliers have the clearest, most complete line-item data, English text, and reliable quantities.

### 2.1 KOA (code `KOA`)
- **Selected document:** `04958058-W (HK) INV.csv`
- **Invoice number:** `04958058-W-01`
- **Document notes:** CSV rows with customer part number, KOA item code, PO number, and quantity. COO = China.

| Line | Part number | Quantity | PO number | COO |
|------|-------------|----------|-----------|-----|
| 1 | `RK73B1JTTD181G` | 15,000 | `1180200568STD` | CN |
| 2 | `RK73H2ATTD1372F` | 40,000 | `1180200568STD` | CN |
| 3 | `RK73H1JTTD1501F` | 5,000 | `1180200859STD` | CN |
| 4 | `RK73H1JTTD2202F` | 5,000 | `1180200859STD` | CN |
| 5 | `RK73H2ATTD1002F` | 70,000 | `1180201327STD` | CN |

### 2.2 ABLIC (code `ABLIC`)
- **Selected document:** `INV NO. 1080082369.pdf`
- **Invoice number:** `1080082369`
- **Document notes:** Second page lists line items with PO numbers; COO = Japan.

| Line | Part number | Quantity | PO number | COO |
|------|-------------|----------|-----------|-----|
| 1 | `S-1206B18-M3T1U` | 3,000 | `1180200571W` | JP |
| 2 | `S-80860CNNB-B9LT2U` | 3,000 | `1180200214` | JP |
| 3 | `S-8240ADJ-I6T1U` | 5,000 | `1180201399` | JP |
| 4 | `S-8240ADJ-I6T1U` | 5,000 | `1180201399` | JP |
| 5 | `S-8240ADJ-I6T1U` | 5,000 | `1180201399` | JP |

### 2.3 DIOTEC (code `DIOTEC`)
- **Selected document:** `INV NO. RE52600142.pdf`
- **Invoice number:** `52600142`
- **Document notes:** Structured lines with delivery-note references; origin codes present (IN/CN/DE). `DBI25-16A` uses the packing-list total.

| Line | Part number | Quantity | PO / reference | Origin |
|------|-------------|----------|----------------|--------|
| 1 | `DBI25-16A` | 900 | `1180200536` | IN |
| 2 | `MM1Z4733A` | 75,000 | `1180200595` | CN |
| 3 | `SL1M` | 300,000 | `1180200706` | CN |
| 4 | `SMF51CA` | 12,000 | `1180201274` | CN |
| 5 | `Z1SMA1020` | 7,500 | `1180201290` | DE |

---

## 3. Recommended pre-existing shelf-inventory parts

Parts selected from suppliers **not** used as the primary receiving orders above. COO is taken from the document and normalized to a 2-letter code.

| Supplier code | Part number | Quantity | Default COO | Source document |
|---------------|-------------|----------|-------------|-----------------|
| `IK` | `IL34063ADT` | 5,000 | KR | `Commercial Invoice(260429E) for Weltronics_ CI, PL.pdf` |
| `KYOCER` | `CX2016SA20000D0HSSCC` | 5,000 | JP | `INV_C227916.pdf` |
| `NCC` | `NCC-TND14V-471KB00AAA0` | 5,000 | ID | `INVOICE-HCC0780458_1327001.pdf` |
| `NDK` | `NX8045GB` | 5,000 | CN | `14519.pdf` |
| `SEIKO` | `Q-SPT7P0327620C5GF` | 5,000 | MY | `WCL Macau-PL_SIH 20260603.pdf` |
| `OKAYA` | `OKAYA-RE104-L` | 5,000 | CN | `SI25002441.pdf` |
| `SHINDE` | `D1FL20U` | 5,000 | JP | `SSE0002181 SI002077 -W006.pdf` |
| `MINEBE` | `04028DA12RBUFB` | 10 | CN | `散箱发票-4102291257.pdf` |

---

## 4. Recommended picking orders

Quantities are chosen so each pick is well below the available stock from the receiving items and pre-existing inventory above.

### Pick order 1 — Resistor kit
| Part number | Quantity |
|-------------|----------|
| `RK73H2ATTD1372F` | 500 |
| `RK73H1JTTD1501F` | 200 |
| `RK73H2ATTD1002F` | 1,000 |

### Pick order 2 — IC / regulator assembly
| Part number | Quantity |
|-------------|----------|
| `S-1206B18-M3T1U` | 100 |
| `S-8240ADJ-I6T1U` | 500 |
| `SL1M` | 2,000 |

### Pick order 3 — Power / protection kit
| Part number | Quantity |
|-------------|----------|
| `DBI25-16A` | 50 |
| `Z1SMA1020` | 200 |
| `OKAYA-RE104-L` | 500 |
| `D1FL20U` | 100 |

### Pick order 4 — Crystal / oscillator bundle
| Part number | Quantity |
|-------------|----------|
| `NX8045GB` | 50 |
| `CX2016SA20000D0HSSCC` | 100 |
| `Q-SPT7P0327620C5GF` | 120 |

### Pick order 5 — General mixed components
| Part number | Quantity |
|-------------|----------|
| `IL34063ADT` | 200 |
| `NCC-TND14V-471KB00AAA0` | 250 |
| `04028DA12RBUFB` | 1 |

---

## 5. Data gaps / assumptions

- **ABLIC `S-8240ADJ-I6T1U`:** appears three times on the invoice with the same PO (`1180201399`); combined quantity is 15,000.
- **DIOTEC `DBI25-16A`:** the seeded receiving quantity uses the packing-list total of 900 across several PO references.
- **M-TRON supplier code:** the derivation script produces code `M` from the supplier name; this is handled automatically.
- **DIOTEC quantities rounded:** the packing list rounds some carton quantities (e.g., `SL1M 120,000` per carton × cartons). The CSV/invoice totals were used where available.
- **KOA part numbers normalised:** the `KOA+` prefix from the customer part-number column was dropped; the KOA item code is used as the part number.
- **NCC / OKAYA / SEIKO part numbers:** vendor/customer P/N from the document was used rather than the internal drawing/model numbers.
- **Unreadable / empty documents:** `DEXERIALS`, `HINODE`, `M-TRON`, `NITSUKO`, `SEMITEC`, `YAMAICHI -MCI` PDF, the two `NIDEC` PDFs, and the `SEIKO` invoice PDF produced no usable extracted text.
- **ICHAUS:** the `R324303`–`R324338` invoices are clean but each is essentially a single-line delivery note; they were kept as shelf/inventory candidates rather than primary receiving orders.
- **SUMITOMO:** quantities are in kilometres, so the document was not used for piece-count inventory.
- **Date codes / lot codes:** present on ABLIC, DIOTEC, ICHAUS, and KYOCERA documents but omitted from the curated tables for brevity; they can be added from the original extraction if required.
