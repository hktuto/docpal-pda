# Seed Curation

Focused data required to populate `db/seed.ts`.
Rationale and source details are in `scripts/extraction-review.md`.

---

## 1. Suppliers

All 26 suppliers from `scripts/extraction-review.md` Section 1.

| code | name |
|------|----------------|
| ABLIC | ABLIC |
| DAITO | DAITO |
| DEXERI | DEXERIALS -MCI |
| DIOTEC | DIOTEC |
| HINODE | HINODE -MCI |
| ICHAUS | ICHAUS -MCI |
| IK | IK Semicon |
| KOA | KOA |
| KYOCER | KYOCERA -MCI |
| M | M-TRON |
| MINEBE | MINEBEAMITSUMI -MCI |
| MMC | MMC |
| NCC | NCC |
| NDK | NDK |
| NIDEC | NIDEC |
| NITSUKO | NITSUKO |
| OKAYA | OKAYA -MCI |
| SEIKO | SEIKO -MCI & MCE |
| SEMIKR | SEMIKRON -MCI |
| SEMITE | SEMITEC |
| SHINDE | Shindengen |
| SUMITO | SUMITOMO -MCI |
| TE | TE -MCI |
| VINA | VINA -MCE |
| YAMAIC | YAMAICHI -MCE |
| YAMA1 | YAMAICHI -MCI |

---

## 2. Parts

Every distinct part number that appears in receiving items, shelf inventory, or picking orders.

| partNo | internalCode | defaultCoo | description |
|--------|--------------|------------|-------------|
| RK73B1JTTD181G | | CN | |
| RK73H2ATTD1372F | | CN | |
| RK73H1JTTD1501F | | CN | |
| RK73H1JTTD2202F | | CN | |
| RK73H2ATTD1002F | | CN | |
| S-1206B18-M3T1U | | JP | |
| S-80860CNNB-B9LT2U | | JP | |
| S-8240ADJ-I6T1U | | JP | |
| DBI25-16A | | IN | |
| MM1Z4733A | | CN | |
| SL1M | | CN | |
| SMF51CA | | CN | |
| Z1SMA1020 | | DE | |
| IL34063ADT | | KR | |
| CX2016SA20000D0HSSCC | | JP | |
| NCC-TND14V-471KB00AAA0 | | ID | |
| NX8045GB | | CN | |
| Q-SPT7P0327620C5GF | | MY | |
| OKAYA-RE104-L | | CN | |
| D1FL20U | | JP | |
| 04028DA12RBUFB | | CN | |

---

## 3. Receiving orders

### KOA — in_hand

```json
{
  "refNo": "04958058-W-01",
  "supplierCode": "KOA",
  "invoiceNo": "04958058-W-01",
  "status": "in_hand",
  "items": [
    { "partNo": "RK73B1JTTD181G", "qty": 15000, "poNo": "1180200568STD", "poLine": 1, "coo": "CN", "cow": "USA" },
    { "partNo": "RK73H2ATTD1372F", "qty": 40000, "poNo": "1180200568STD", "poLine": 2, "coo": "CN", "cow": "USA" },
    { "partNo": "RK73H1JTTD1501F", "qty": 5000, "poNo": "1180200859STD", "poLine": 3, "coo": "CN", "cow": "USA" },
    { "partNo": "RK73H1JTTD2202F", "qty": 5000, "poNo": "1180200859STD", "poLine": 4, "coo": "CN", "cow": "USA" },
    { "partNo": "RK73H2ATTD1002F", "qty": 70000, "poNo": "1180201327STD", "poLine": 5, "coo": "CN", "cow": "USA" }
  ]
}
```

### ABLIC — in_hand

```json
{
  "refNo": "1080082369",
  "supplierCode": "ABLIC",
  "invoiceNo": "1080082369",
  "status": "in_hand",
  "items": [
    { "partNo": "S-1206B18-M3T1U", "qty": 3000, "poNo": "1180200571W", "poLine": 1, "coo": "JP", "cow": "USA" },
    { "partNo": "S-80860CNNB-B9LT2U", "qty": 3000, "poNo": "1180200214", "poLine": 2, "coo": "JP", "cow": "USA" },
    { "partNo": "S-8240ADJ-I6T1U", "qty": 15000, "poNo": "1180201399", "poLine": 3, "coo": "JP", "cow": "USA" }
  ]
}
```

### DIOTEC — pending

```json
{
  "refNo": "52600142",
  "supplierCode": "DIOTEC",
  "invoiceNo": "52600142",
  "status": "pending",
  "items": [
    { "partNo": "DBI25-16A", "qty": 900, "poNo": "1180200536", "poLine": 1, "coo": "IN", "cow": "USA" },
    { "partNo": "MM1Z4733A", "qty": 75000, "poNo": "1180200595", "poLine": 2, "coo": "CN", "cow": "USA" },
    { "partNo": "SL1M", "qty": 300000, "poNo": "1180200706", "poLine": 3, "coo": "CN", "cow": "USA" },
    { "partNo": "SMF51CA", "qty": 12000, "poNo": "1180201274", "poLine": 4, "coo": "CN", "cow": "USA" },
    { "partNo": "Z1SMA1020", "qty": 7500, "poNo": "1180201290", "poLine": 5, "coo": "DE", "cow": "USA" }
  ]
}
```

---

## 4. Shelf inventory

Pre-existing parts on shelves.

| partNo | shelfCode | totalQty | coo | cow |
|--------|-----------|----------|-----|-----|
| IL34063ADT | A-01-01 | 5000 | KR | USA |
| CX2016SA20000D0HSSCC | A-01-02 | 5000 | JP | USA |
| NCC-TND14V-471KB00AAA0 | A-01-03 | 5000 | ID | USA |
| NX8045GB | A-01-04 | 5000 | CN | USA |
| Q-SPT7P0327620C5GF | A-01-05 | 5000 | MY | USA |
| OKAYA-RE104-L | A-01-06 | 5000 | CN | USA |
| D1FL20U | A-01-07 | 5000 | JP | USA |
| 04028DA12RBUFB | A-01-08 | 10 | CN | USA |

---

## 5. Picking orders

| refNo | supplierCode | poNo | shipTo | destinationCountry | items |
|-------|--------------|------|--------|--------------------|-------|
| PICK-001 | KOA | PO-PICK-001 | US | USA | RK73H2ATTD1372F × 500, RK73H1JTTD1501F × 200, RK73H2ATTD1002F × 1000 |
| PICK-002 | ABLIC | PO-PICK-002 | CN | China | S-1206B18-M3T1U × 100, S-8240ADJ-I6T1U × 500, SL1M × 2000 |
| PICK-003 | DIOTEC | PO-PICK-003 | US | USA | DBI25-16A × 50, Z1SMA1020 × 200, OKAYA-RE104-L × 500, D1FL20U × 100 |
| PICK-004 | KYOCER | PO-PICK-004 | CN | China | NX8045GB × 50, CX2016SA20000D0HSSCC × 100, Q-SPT7P0327620C5GF × 120 |
| PICK-005 | IK | PO-PICK-005 | US | USA | IL34063ADT × 200, NCC-TND14V-471KB00AAA0 × 250, 04028DA12RBUFB × 1 |

---

## Verification notes

- **Part coverage:** All 21 receiving/shelf/picking part numbers appear exactly once in the Parts list.
- **Picking coverage:** Every picking quantity is well below the available receiving + shelf stock:
  - KOA stock covers pick 1 (e.g. RK73H2ATTD1002F: 70,000 vs pick 1,000).
  - ABLIC/DIOTEC stock covers pick 2 (S-8240ADJ-I6T1U: 15,000 vs pick 500; SL1M: 300,000 vs pick 2,000).
  - DIOTEC/shelf stock covers pick 3 (DBI25-16A: 900 vs pick 50; OKAYA-RE104-L: 5,000 vs pick 500).
  - Shelf stock covers picks 4 and 5 (e.g. NX8045GB: 5,000 vs pick 50; 04028DA12RBUFB: 10 vs pick 1).
