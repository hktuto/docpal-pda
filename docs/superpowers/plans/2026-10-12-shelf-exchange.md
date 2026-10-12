# Shelf Exchange — Implementation Plan

Spec: `docs/superpowers/specs/2026-10-12-shelf-exchange-design.md`
(read it first — scope decisions live there).

## Phase 1 — backend

1. **Schema** (`src/db/schema/shelfExchange.ts`): `shelfExchanges` table per
   spec §Data model (audit row: source/target shelf + lot FKs, part keys,
   qty, label snapshot, org pair, actor). Export from `schema/index.ts`.
   Run `pnpm --filter @warehouse/backend db:generate`.
2. **Domain** (`src/db/shelfExchange.ts`):
   - `previewShelfExchange(db, input)` — validate source shelf (404
     `shelf_not_found`), resolve the lot (part keys space-insensitive via
     `normalizePartNo`, label `dateCode`/`lotCode`/`coo`/`cow` match when
     carried, `allowedOrgFilter`, exclude lots whose shelf is missing from
     `shelves`, FIFO `date_code ASC NULLS LAST`, first lot with
     `total_qty >= qty`); 409 `no_stock_at_location`, 409
     `insufficient_available_qty` when `available_qty < qty`. Returns the
     matched lot + available.
   - `commitShelfExchange(db, {sourceShelfCode, targetShelfCode, lotId,
     qty, actorId})` — single tx: re-validate lot pinned to source shelf +
     availability; validate target shelf (404) ≠ source (400
     `same_shelf`); source `total_qty -= qty`; find-or-create target lot
     on the unique-index key (`box_id` NULL, org/sub-inventory from
     source, `wcl_item_no`/`lot_code`/`drawing_no` copied from source on
     create) `total_qty += qty`; insert `shelf_exchanges` audit row; two
     `inventory_transactions` rows (`txnType: "MOVE"`, `qtyType:
     "on_hand"`, −qty source / +qty target, `referenceType:
     "shelf_exchange"`, `referenceId` = audit id); `lastUpdateDate`
     stamps. Route calls `scheduleAllocateAll` after commit.
3. **Route** (`src/routes/shelfExchange.ts`): `POST /shelf-exchange/preview`
   and `POST /shelf-exchange` per spec — snake_case `HTTPException`
   messages, `actorFrom(c).id`, `readJson` helper pattern from
   `routes/adhocPutaway.ts`. Mount in `src/index.ts`.
4. **Flow step**: `src/config.ts` `FLOW_STEPS` += `"shelf-exchange"` (also
   covers the admin flow-config PUT validation automatically — but add the
   key to `apps/admin/pages/flow-config.vue` `STEPS` so the toggle renders).
5. **Tests** (`src/db/shelfExchange.test.ts`, mirror
   `adhocPutaway.test.ts` setup): preview resolution + FIFO + errors;
   commit move/merge/ledger/audit + errors (spec §Tests).
   Run `pnpm --filter @warehouse/backend test` and `build` (tsc).

## Phase 2 — PDA (`apps/pda`)

6. **Service layer**: `services/types.ts` — `ShelfExchangePreview`/
   `ShelfExchangeResult` DTOs + `FlowStep` union += `"shelf-exchange"`;
   `services/warehouse.ts` interface +
   `adapters/backendWarehouse.ts` — `previewShelfExchange(input)`,
   `commitShelfExchange(input)`.
7. **Flow steps**: `composables/useFlowSteps.ts` default record +=
   `shelf-exchange: true`.
8. **Page** (`pages/shelf-exchange/index.vue`) — step state machine:
   - `sourceShelf` ref (banner + clear), `matchedLot` ref (preview
     result card), `targetShelf` ref, `confirming` ref.
   - `useHardwareScanner` onScan: shelf match (from `getShelves()`,
     case-insensitive) routes by step (awaiting source → set/replace;
     awaiting target → set, client-reject equal to source); otherwise
     parse label → `previewShelfExchange` → set matchedLot (409s →
     error toast, stay).
   - Camera path: `captureLabel` + `parseQrCapture` (QR-only) /
     `parseAndIdentify` fallback → same preview call.
   - Confirm modal (`components/ShelfExchangeConfirmModal.vue`) →
     `commitShelfExchange` → success toast → clear matchedLot +
     targetShelf, keep sourceShelf.
   - `useVisibleReload(load)` for shelves; `useBrandSymbologyScope([], +
     withShelfCodes)` — no brand context, shelf QRs always decodable.
9. **Home tile** (`pages/index.vue`): `v-if="flowSteps['shelf-exchange']"`
   + icon style.
10. **i18n** (`layers/i18n/i18n/locales/{en-US,zh-CN,zh-HK}.ts`):
    `meta.shelfExchange`, `home.menu.shelfExchange.title`,
    `shelfExchange.*` per spec.
11. Verify: `pnpm --filter @warehouse/pda nuxt prepare` + `test`.

## Phase 3 — docs

12. `docs/backend/api-design.md` — new "Shelf exchange" section (both
    endpoints); `docs/backend/schema-tables.md` — `shelf_exchanges` row;
    `docs/backend/event-catalog.md` — none (no new events).
13. `docs/app-docs/flows/shelf-exchange/{overview.md,steps.md,ai-scope.md}`
    (+ TOC entry in `docs/app-docs/README.md`),
    `ai/feature-registry.md`, `ai/code-map.md`.

## Phase 4 — verify + commit

14. Backend tests + tsc, PDA tests + nuxt prepare; manual flow check with
    `pnpm dev:backend` + `pnpm --filter @warehouse/pda dev`.
15. Commit.
