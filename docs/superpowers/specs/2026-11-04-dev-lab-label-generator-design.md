# Dev Lab — supplier label generator (v1)

Date: 2026-11-04 · Status: implemented · App: `apps/backend` (dev-only)

## Problem

Developer testing is blocked by upstream sync: records (orders, stock) only arrive from the external sync service, and a label scan needs a **real physical reel** — the date code, COO and qty on a KOA/NCC label can't be changed, so scanning flows are slow to exercise.

## v1 scope (this spec)

A dev-only helper page generating **supplier-label barcodes on demand**: pick brand/supplier + part, edit qty / date / lot / COO / serial, get a scannable barcode in the supplier's own symbology. Record spawning is explicitly deferred (see Open questions).

## Design

All under `/dev/lab*` on the backend — inside the existing `/dev/*` auth allowlist and the `DEV_ROUTES` gate (unmounted in production; `docker-compose.prod.yml` sets `DEV_ROUTES=off`).

| Piece | File |
|---|---|
| Per-supplier label builders (pure) | `src/lab/labelBuilders.ts` |
| Single-page UI (no build step) | `src/lab/page.ts` |
| Routes + DB reads + bwip-js render | `src/routes/devLab.ts` |
| Round-trip unit test (no DB) | `src/lab/labelBuilders.test.ts` |

Endpoints:

- `GET /dev/lab` — the page.
- `GET /dev/lab/data` — supplier profiles (code, name, brands, `qr_type`, `barcode_types`) with the builder's field list, or `fields: null` when no builder exists.
- `GET /dev/lab/parts?brand=` — parts (≤300) with `drawnos` from the externally-managed `wcl_part_drawno` (missing table = empty drawnos).
- `POST /dev/lab/label` — build the raw label, then **feed it through the real decoder** (`parseQrRaw` with the profile's template + encodings + `date_code_counter_periods` + flow `dateCodeFormat`) and return `{raw, decoded}`. A built label that does not decode back carries a `warning` — a generated label can never silently disagree with what the PDA scan path reads.
- `POST /dev/lab/barcode` — render any text as PNG (base64 JSON) with `bwip-js`; symbology selectable: `qrcode` / `datamatrix` / `pdf417` / `interleaved2of5`, defaulting to the supplier's `qr_type`.

Builders cover the 8 seeded templates of `src/db/seed-supplier-profiles.ts` (KOA, iC-Haus, NCC 28/32-char, COPAL, SII/ABLIC, TE, NDK), keyed by `supplier_code`. KOA reuses `buildKoaLabelRaw`; the others are ~10-line string builders. The date input (real calendar date) is converted per label to its native encoding: KOA month counter, NCC/COPAL YMMDD, SII YYYYMM, TE YYWWD, iC-Haus/TE canonical.

**Symbology matters**: the PDA hardware decoder is whitelisted per supplier (`useSupplierSymbologyScope`), so a QR-rendered "KOA" label would not even decode on the receiving screen — hence matching `qr_type`/`barcode_types` in v1.

Known template limits: NCC 32-char (KTD) labels carry a 7-digit lot with no decodable date (existing decoder behaviour); COO exists only on the iC-Haus label, and **no template carries COW** (it is keyed in by the operator in the receiving UI) — the lab can't fake what no label encodes.

### shortcut notes in code

- COPAL's 12-digit internal code segment is a constant (decoder ignores it).
- Advanced-mode / admin-editor-created templates get no builder — the page's raw-text mode renders any string, and paste works via the keyboard-wedge fallback regardless of symbology.

## Open questions (v2 — spawn records)

Deferred pending discussion:

1. Which flow should a spawned record land in — receiving-order only (orders + invoices + items, trivial with `src/db/test-fixtures.ts`) vs picking-ready (needs `inventory_lots` + shelf + allocations — fake rows or run the real put-away?).
2. Cleanup strategy: `[TEST]`-remark cascade per table (the `admin/testPickingOrder.ts` pattern) vs a dedicated test org/sub-inventory deleted wholesale.
3. Surface: same dev page (zero auth) vs admin console (already hosts the test picking-order creator).

Leaning: v2 spawns a receiving order you immediately receive, and stock appears by completing that order with v1's generated labels — going through the real pipeline instead of inventing a second one.
