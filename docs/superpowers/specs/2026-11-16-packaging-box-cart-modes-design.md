# Packaging (打包) confirm — box mode vs cart (卡板) mode

Date: 2026-11-16 · Status: draft · Apps: backend, pda, admin
Builds on: `2026-11-10-packaging-shipping-steps-design.md` (the packaging stage itself).

## 1. Goal

The CN packaging confirm needs two input modes instead of today's "weight + (auto box count |
pallet count)" form:

1. **按箱 (by box)** — the order's scanned box count is shown as-is (auto count, not editable);
   the operator enters a **打包記錄箱數 (packed box count)** — a packaging-record figure that
   never overrides the scan records — plus the **total weight**.
2. **按卡板 (by cart/pallet)** — the input is an **array**: one row per cart (auto-numbered
   卡板 1, 卡板 2, …), each with its **box count** and **weight**. Total carts = row count.

Decisions confirmed with the requester (2026-11-16):

- Box mode keeps **both** numbers: the operator's packed box count (new field) *and* the
  existing auto scan count, so the two can be compared.
- Cart rows are **auto-numbered** (no free-text cart label); each row = box count + weight.
- Scope = **backend + PDA + admin** (both confirm forms share the same endpoint).

## 2. Decisions

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| D1 | Confirm payload | `POST /packaging-orders/:orderId/confirm` takes `{ mode: "box", weight, boxCount }` or `{ mode: "pallet", pallets: [{ boxCount, weight }] }` | One endpoint, mode-explicit; old clients keep working (legacy shim, §4). |
| D2 | Packed box count storage | new nullable column `packed_input_box_count` (integer) on `picking_orders`; the existing `packed_box_count` stays the server-recomputed auto scan count | "Both stored" decision; scan records never overridden (the D9 auto-count rule of the base spec keeps holding). |
| D3 | Cart array storage | new nullable `jsonb` column `packed_carts` on `picking_orders` (`[{boxCount:int, weight:real}]`, array order = cart number) | Additive, order-local, no new table — the array is display/copy data, never joined. |
| D4 | Derived values on confirm (cart mode) | `packed_pallet_count = pallets.length`, `packed_input_box_count = Σ cart boxCount`, `packed_weight = Σ cart weight` (kg, ≤3 dp) | Read-back + shipping pages keep showing the same scalar columns they already do; totals are derived server-side, never trusted from the client. |
| D5 | Box-mode validation | `boxCount` integer ≥ 1; `weight` > 0 (unchanged rule) | 0 boxes cannot happen — the queue predicate already requires every package boxed. |
| D6 | Pallet-mode validation | `pallets` array length ≥ 1; each row `boxCount` integer ≥ 1, `weight` > 0 | Mirrors the box-mode rules per row. |
| D7 | Legacy payload shim | `{ weight, palletCount? }` (no `mode`) still accepted → box mode with `packed_input_box_count = NULL` (+ `packed_pallet_count` when given, no carts) | Old PDA APKs in the field keep confirming; new clients always send `mode`. |
| D8 | PDA detail form | boxes/pallets segmented toggle becomes 按箱 / 按卡板; box mode = 箱數 + 總重量 inputs (auto scan count shown as reference); cart mode = dynamic rows + add/remove + computed totals | The two input types of the requirement. |
| D9 | Per-box listing on PDA detail | removed — box summary shows the scanned box count only ("no need for detail") | Requester; admin detail keeps its boxes table for review. |

## 3. Backend

### 3.1 Schema (migration via `db:generate`, next number 0066)

`picking_orders` additive nullable columns:

| column | type | meaning |
| --- | --- | --- |
| packed_input_box_count | integer | operator-entered 打包記錄箱數 (box mode) / Σ cart box counts (cart mode); NULL = legacy confirm |
| packed_carts | jsonb | cart mode array `[{boxCount, weight}]` (array index + 1 = cart number); NULL = box mode |

### 3.2 Domain `src/db/packaging.ts`

- `PackagingOrderRow` += `packedInputBoxCount: number | null`, `packedCarts: {boxCount:number; weight:number}[] | null`
  (jsonb parsed in SQL via `::jsonb` → returned as object; row/detail SELECT + the adapter `packagedRow` test helper pick it up).
- `confirmPackaging(db, { orderId, input: ConfirmPackagingInput, actorId })`:
  - parses/validates per D5/D6 (`invalid_weight` / `invalid_box_count` / `invalid_pallets`);
  - cart mode stores `packed_carts` + derived scalars (D4); box mode stores `packed_input_box_count` + total weight;
  - everything else (queue predicate re-check 409, ledger, `picking.packaged` event) unchanged —
    event metadata gains the full input (`boxCount` / `pallets`).
- Legacy shim (D7) lives in the route, which normalizes the body into the typed input.

### 3.3 Route `src/routes/packaging.ts`

Body parsing: `mode` present → new shape; absent → legacy `{weight, palletCount?}` (D7).

### 3.4 Side updates

- `picking.ts` admin-order-reset UPDATE clears the two new columns alongside `packed_*`.
- `shipping.ts` box-detail order rows SELECT gains `packed_input_box_count`, `packed_carts`
  (for the packaged panel + copy summary).

## 4. PDA (`apps/pda`)

`pages/packaging/[orderId].vue`:

- Box summary card: `boxes` (auto count) + `packages`; per-box DetailRow list removed (D9).
- Form (pending): mode toggle 按箱 / 按卡板.
  - 按箱: hint line 「已掃描 N 箱」, inputs 箱數 (打包記錄) + 總重量; confirm `{mode:"box", weight, boxCount}`.
  - 按卡板: rows 卡板 1..n each 箱數 + 重量; +新增卡板 / remove; computed totals line (總板數 / 總箱數 / 總重量); confirm `{mode:"pallet", pallets:[…]}`.
- Packaged read-back: box mode → 打包箱數 (input) + 自動統計箱數 + weight; cart mode → per-cart
  table + totals.
- Adapter `confirmPackaging(orderId, payload)` payload-typed; vitest URL/payload tests updated.

## 5. Admin (`apps/admin`)

- `pages/packaging/[id].vue`: same two-mode form as PDA (desktop styling); packaged read-back mirrors PDA.
- `pages/shipping/[id].vue`: packaged cell keeps `weight · boxes · pallets`; copy summary appends
  per-cart lines when `packedCarts` exists (卡板1: 5箱/30kg; …).
- `flowApi.ts`: `confirmPackagingOrder(orderId, payload)` + types.

## 6. i18n

`packaging.*` (PDA) and `admin.pages.packaging.*` keys: new mode labels, per-cart row labels,
totals, validation messages; en-US / zh-CN / zh-HK.

## 7. Testing

- `packaging.test.ts`: box-mode confirm stores input count + auto count; cart-mode confirm stores
  the array + derived totals; payload validation matrix (boxCount 0 / 1.5, empty pallets, row
  weight ≤ 0); legacy payload still confirms; double-confirm 409 unchanged.
- Adapter tests: new payload shape for both apps.

## 8. Docs & tracking

- `docs/backend/api-design.md` confirm payload; `docs/backend/schema-tables.md` new columns;
- `docs/app-docs/flows/packaging/{overview,steps,ai-scope}.md`; `docs/dev-guide-zh/flows/packaging.md`;
- `docs/app-docs/ai/feature-registry.md` packaging line; `docs/uat/functions.json` PDA-052/ADM-041
  wording + `node scripts/gen-uat-xlsx.mjs`.

## 9. Out of scope

- Per-box → per-cart assignment (scanning which boxes sit on which cart) — the cart rows are
  manual figures like today's pallet count.
- Editing/un-confirming a packaged order.
- 寄出 flow changes beyond the copy-summary cart lines.
