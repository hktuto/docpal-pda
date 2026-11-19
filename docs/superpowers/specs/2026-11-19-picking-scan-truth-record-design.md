# Picking Scan Truth Record — decode NCC labels, persist what was scanned

Date: 2026-11-19
Status: draft

## Problem

Incident: SZ order `01a1f182-06c2-7319-b8d4-06b9c66fcba8` (VMI-VMAX20261123-1,
picking_finished 2026-11-19). 59 package rows, all NCC part
NCC-EGXE630EC3471MK30S, every row shows `date_code = '0126'`,
`lot_code`/`coo`/`cow` empty — while the physical reels carry real printed
values (e.g. box BOX-S-20261119-0021's reel is date code **2512**).

Root causes, verified against the production DB:

1. **The scanned label was never decoded.** `scanned_date_code`,
   `scanned_lot_code`, `scanned_coo`, `scanned_cow` are NULL on all 59
   packages. SZ `supplier_profiles` has **no NCC QR template** — supplier
   `23` (HONGKONG CHEMI-CON LTD, brands `{NCC}`) has an empty `qr_template`.
   Only NDK/TE/SII/ABLIC have templates on SZ. `POST /scan/decode` returns
   `matched:false`; the client-side fallback (`parseAndIdentify`) cannot
   parse NCC's fixed-width 28-digit code either.
2. **What is stored is a snapshot of the aggregate inventory lot**, not the
   scan. `scanPickingItem` copies `date_code/lot_code/coo/cow` from the
   allocated `inventory_lots` row into the package. All reels sit in ONE lot
   with date code `0126`, so every box inherits that value regardless of
   which physical reel went into it.
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

### 2. NCC date-code convention — YYMM, decided before rollout

The NCC 13-digit lot's first 5 digits are YMMDD (one-digit year, MM, DD):
`51215` → 2025-12-15, `60129` → 2026-01-29.

Existing helper `decodeNccDateCode` (`src/decode/codecs.ts`) converts this
to an **ISO-week** code (2025-12-15 → week 51 → "2551"). But the label the
user (and the physical reel) expects is **2512 = YYMM** (year 25, month 12).

Decision recorded here: NCC date codes are **YYMM**, derived from the lot's
YMMDD (year digit → 20YY, take MM). Add `date_code_encoding = "ncc_lot_ymm"`
alongside the existing `ncc_lot_ymmdd`, mapping `lot[0..4]` → `20{Y}{MM}`.
Because YYWW canonical storage is week-based, YYMM values cannot be stored
as canonical date codes — NCC scanned date codes stay in the label's own
YYMM form and are stored in `scanned_date_code` verbatim (see 3), with
lot/package snapshot comparison treating a YYMM value as "cannot compare,
do not reject" (same philosophy as `compareDateCodes`' null path). The
scan Excel prints them as-is in the original-format column.

Open question for the user before implementation: confirm the printed
convention is YYMM (2512 = 2025-12), not ISO week.

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
`inventory_lots.drawing_no`; the decode's `itemId` (NCC drawing code) should
also be persisted per scan — add a `scanned_drawing_no` (or reuse
`scanned_part_no` storing the raw itemId) column on `picking_packages` so
the record carries the label's own identity, independent of the lot join.

### 4. Scan-event log (decode audit trail)

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

### 5. Lot-granularity follow-up (recorded, not in this change)

Even with decode fixed, the package snapshot still comes from an aggregate
lot (one lot, date 0126, mixed reels). The decode value will now be
authoritative in reports, but receiving should eventually create one
inventory lot per reel date code so the stock snapshot itself is truthful.
Tracked as a separate piece of work; this spec only fixes the scan side.

## Verification

- Backend unit test: decode `6245005121592004433007503018` →
  itemId `624500`, lot `5121592004433`, qty 750, serial `3018`,
  scannedDateCode `2512`.
- Integration: scan the incident's barcodes through `/scan/decode`, commit a
  picking scan, assert `scanned_date_code='2512'`, `label_barcode` raw,
  `scan_events` row exists.
- Manual: re-run the incident order's flow on the SZ clone; download the
  pick-scan Excel and confirm box 0021 shows 2512.

## Files expected to change

- `apps/backend/src/decode/codecs.ts` (ncc_lot_ymm encoding)
- `apps/backend/src/decode/template.ts` (fixed-width template support if
  regex form is insufficient)
- `apps/backend/src/decode/service.ts` + `routes/decode.ts` (scan_events
  write)
- `apps/backend/src/schema/*.ts` + migration (`scan_events`,
  `scanned_drawing_no` on picking_packages)
- `supplier_profiles` seed/config for NCC on each warehouse
- `apps/admin/utils/pickingScanExcel.ts` (drawing column already exists —
  wire `scanned_drawing_no` in)
