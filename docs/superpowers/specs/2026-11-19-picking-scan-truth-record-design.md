# Picking Scan Truth Record — decode NCC labels, persist what was scanned

Date: 2026-11-19
Status: draft

## Problem

Incident: SZ order `01a1f182-06c2-7319-b8d4-06b9c66fcba8` (VMI-VMAX20261123-1,
picking_finished 2026-11-19). 59 package rows, all NCC part
NCC-EGXE630EC3471MK30S, every row shows `date_code = '0126'`,
`lot_code`/`coo`/`cow` empty — while the physical reels carry real printed
values (e.g. box BOX-S-20261119-0021's reel is date code **2512**).

Root causes, verified against the production DB + code (2026-11-19):

1. **The PDA drops the scanned date/lot/COO/COW at the POST boundary.**
   The decode itself works — supplier 23 DOES have the NCC template
   (`qr_type=itf`, `date_code_encoding=ncc_lot_ymmdd`; an earlier read of
   truncated psql output wrongly reported it empty), and decoding
   `6245005121592004433007503018` yields itemId `624500`, qty 750,
   dateCode `2551` (ncc_lot_ymmdd → ISO week), wcl `NCC/624500` resolved
   via the drawing-code resolver. `scanned_part_no`/`scanned_wcl_item_no`
   are populated on all 59 packages — but `scanned_date_code`,
   `scanned_lot_code`, `scanned_coo`, `scanned_cow` are NULL because
   `apps/pda/pages/picking/unified/[id].vue` `confirm()` posts
   `scannedPartNo`/`scannedWclItemNo` yet omits `scannedDateCode`,
   `scannedLotCode`, `scannedCoo`, `scannedCow` — all four exist on the
   queue row (`usePickingScanQueue.addScan`) and are never sent.
2. **The lot snapshot wins over the decoded value at commit time.**
   `scanPickingItem` stores `date_code = portion(lot).dateCode ??
   input.dateCode` — the client's decoded `2551` is discarded in favour of
   the aggregate lot's `0126`. Same for coo/cow. (The scanned_* columns,
   once 1 is fixed, sidestep this: they exist precisely to keep the label's
   own values, and reports prefer them via
   `COALESCE(pp.scanned_date_code, pp.date_code)`.)
3. **`POST /scan/decode` persists nothing.** The raw barcode IS logged
   (`picking_packages.label_barcode`), and the decoded result is persisted
   only when a scan commits. Failed/`matched:false` decode attempts leave no
   trace beyond a `[DECODE-TIME]` console line.

Principle requested by the user: **the scan record is the truth of what we
ship.** Whatever the label physically says (date code, lot code, COO, COW,
drawing) must appear on the scan record as-scanned, even when the order or
the stock lot carries different (or no) values. The order/allocation is the
plan; the scan is the fact.

## Design

### 1. NCC QR template on supplier_profiles (config, not code)

Add the NCC template to `supplier_profiles` on each warehouse DB (SZ first;
HK likely already decodes NCC — verify before touching). NCC QR is
fixed-width 28 chars:

```
itemId(6) | lot(13) | qty(5) | serial(4)
624500     5121592004433  00750  3018
```

The template needs a fixed-width matcher (the current template engine is
regex-over-templates; add a `fixed_width` template config mode, or express
this layout as `^(?<itemId>\d{6})(?<lotCode>\d{13})(?<qty>\d{5})(?<serialNo>\d{4})$`
with a brand gate on NCC drawing-code part numbers). Qty encoding is plain
decimal (`00750` → 750) — no KOA-style month-counter arithmetic.

NCC brand resolution already exists (`src/decode/brands/ncc.ts`): `itemId`
is the numeric drawing code, resolved to `wcl_item_no` via
`wcl_part_drawno` (`lookupPartsByDrawingNo`). No change needed there.

### 2. NCC date-code convention — ISO week confirmed (no change)

User confirmed 2026-11-19: `ncc_lot_ymmdd`'s ISO-week output is correct
(lot `5121592004433` → 2025-12-15 → `2551`). The earlier "2512 = YYMM"
reading is withdrawn. No codec change needed.

### 3. Scanned fields win, snapshot fills gaps (existing rule, now actually used)

`scanPickingItem` already normalizes "label carried it" vs "lot carried it":
empty scanned fields → NULL → verify/measuring/report fall back to the lot
snapshot (`COALESCE(pp.scanned_date_code, pp.date_code)` pattern, e.g.
`db/picking.ts` line ~2448, `db/verify.ts` line ~393). With the template in
place the decode fills `scanned_date_code/scanned_lot_code/scanned_coo/
scanned_cow` and the scanned values flow through unchanged. No new columns.

The scan Excel (`apps/admin/utils/pickingScanExcel.ts`) already prints
`p.scannedCoo ?? p.coo ?? ""` etc. — with decode fixed, COO/COW appear when
the label carries them and stay empty when it does not. Report date-code
columns likewise prefer `scannedDateCode`.

`drawing_no`: for lot-sourced packages the package API already joins
`inventory_lots.drawing_no`; this change also persists the label's own
identity per scan:

- New `scanned_drawing_no` column on `picking_packages`. For NCC the
  decode's `itemId` IS the drawing code (`624500`), so the PDA posts it;
  the backend stores it verbatim.
- PDA `confirm()` (`apps/pda/pages/picking/unified/[id].vue`) gains a
  `scannedDrawingNo` param alongside the four missing scanned_* params.
- Scan Excel drawing column: prefer `p.scannedDrawingNo ?? p.drawingNo ?? ""`.
- `POST /scan/decode` should return the drawing code explicitly as
  `drawingNo` (the decode result already carries it as `itemId`; echo it
  under both keys so the PDA doesn't brand-gate the mapping).

### 4. Client fix — post the four scanned fields (+ drawing no)

`apps/pda/pages/picking/unified/[id].vue` `confirm()` currently posts
`scannedPartNo`/`scannedWclItemNo` only. Add to the `scanPickingItem` body:
`scannedDateCode: row.scannedDateCode`, `scannedLotCode: row.scannedLotCode`,
`scannedCoo: row.scannedCoo`, `scannedCow: row.scannedCow`,
`scannedDrawingNo: row.scannedDrawingNo` (new queue-row field: the decode's
`itemId` when the profile's brand resolves it as a drawing code — NCC).
The queue rows already carry the first four; only the POST drops them.
Backend `scanPickingItem` accepts the new optional field and stores it;
empty/absent → NULL (same normalization as the other scanned_* columns).

### 5. Scan-event log (decode audit trail)

New table `scan_events` (id text PK, created/last_update per convention):

```
id, source ('picking'|'receiving'|'stock_search'|...), raw text,
matched boolean, template_id text null, parsed jsonb (the decoded fields),
actor_id text null, created_date, last_update_date
```

`POST /scan/decode` writes one row per call (fire-and-forget insert after
responding — must not add latency; on insert failure just console.warn).
This gives the "what was scanned → what we decoded" audit trail including
`matched:false` attempts, which today vanish.

### 6. Lot-granularity follow-up (recorded, not in this change)

Even with decode fixed, the package snapshot still comes from an aggregate
lot (one lot, date 0126, mixed reels). The decode value will now be
authoritative in reports, but receiving should eventually create one
inventory lot per reel date code so the stock snapshot itself is truthful.
Tracked as a separate piece of work; this spec only fixes the scan side.

## Verification

- Backend unit test: decode `6245005121592004433007503018` →
  itemId/drawingNo `624500`, lot `5121592004433`, qty 750, serial `3018`,
  scannedDateCode `2551` (ISO week — confirmed convention).
- Integration: scan the incident's barcodes through `/scan/decode`, commit a
  picking scan, assert `scanned_date_code='2551'`,
  `scanned_drawing_no='624500'`, `label_barcode` raw, `scan_events` row
  exists.
- Manual: re-run the incident order's flow on the SZ clone; download the
  pick-scan Excel and confirm box 0021 shows 2551 + drawing 624500.

## Files expected to change

- `apps/backend/src/decode/codecs.ts` (echo drawingNo alongside itemId)
- `apps/backend/src/decode/template.ts` (fixed-width template support if
  regex form is insufficient)
- `apps/backend/src/decode/service.ts` + `routes/decode.ts` (scan_events
  write)
- `apps/backend/src/schema/*.ts` + migration (`scan_events`,
  `scanned_drawing_no` on picking_packages)
- `supplier_profiles` seed/config for NCC on each warehouse
- `apps/admin/utils/pickingScanExcel.ts` (drawing column already exists —
  wire `scanned_drawing_no` in)
