# Supplier Outdated Date-Code Scan Warning — Implementation Plan

Spec: `docs/superpowers/specs/2026-10-07-supplier-outdated-datecode-warning-design.md`
(read it first — scope decisions live there).

## Phase 1 — backend

1. **Shared WWYY helpers** — new `apps/backend/src/db/dateCode.ts`: move
   `dateCodeRank` / `dateToDateCode` (and the 2-digit-year window logic) out of
   `stocksearch.ts`; add `outdatedThresholdRankMonths(months, ref = new Date())`.
   `stocksearch.ts` imports from it (its SQL-side rank expression stays put).
2. **Schema** (`src/db/schema/master.ts`): add
   `outdatedLimitMonths: integer("outdated_limit_months")` (nullable) to
   `supplierProfiles`. New table `outdatedScanWarnings` per spec §Data model
   (new schema file, exported wherever the other schema files are aggregated).
   Run `pnpm --filter @warehouse/backend db:generate`; the migration backfills
   existing profiles to 12.
3. **`src/db/outdated.ts`** —
   - `checkOutdatedDateCode(db, { supplierCode, dateCode, now? })` →
     `null | { limitMonths: number }` (null = pass: no profile / NULL limit /
     invalid date code).
   - `recordOutdatedWarning(tx, {...})` — insert + `emitEvent`
     (`outdated.warning.created`, topics `["/admin/outdated-warnings", orderTopic]`).
   - `unresolvedOutdatedWarningCount(tx|db, orderKind, orderId)`.
   - `resolveOrderOutdatedWarnings(db, { orderKind, orderId, note, actorId })` —
     stamp all unresolved rows, emit `outdated.warning.resolved`.
4. **Picking scan** (`src/db/picking.ts`): in `scanPickingItem` and
   `scanIntoShippingBox`, after the package row is created in the same tx —
   resolve the supplier profile via the item's `brand` matched against
   `supplier_profiles.brands` (same lookup style as the brand whitelist), run
   the check, record the warning, and add `outdatedWarning` to the returned
   result (`null` when clean). `POST /shipping-boxes/:id/scan` gains an
   optional `dateCode` body field so that path can warn (the barcode alone
   does not carry the decoded date code).
5. **Put-away scan** (`src/db/putaway.ts` `recordPutAwayScan`): supplier comes
   from the receiving order's `supplier_code` directly; same pattern.
6. **Block completion** (order-completion points, NOT the put-away commit) —
   `finishPickingOrder` (picking.ts:2219): unresolved count > 0 → 409 with a
   JSON body `{"error":"unresolved_outdated_warnings","count":N}`
   (`assertNoUnresolvedOutdatedWarnings` /
   `unresolvedOutdatedWarningsError`); `maybeAutoFinishPickingOrder` holds
   (returns false, order stays `picking`) while warnings are unresolved.
   Put-away: `commitPendingScansToShelf` (putaway.ts:1117) stays unblocked —
   instead `tryMarkReceivingOrderClear` holds the `clear` transition + task
   completion while warnings are unresolved. Add
   `retryAutoFinishPickingOrder` / `retryReceivingOrderClear` (the resolve
   route re-runs them). Admin status overrides stay unblocked.
7. **Order surfaces**: add `outdatedWarningCount` (unresolved only) to
   `listPickingOrders`, `getPickingOrderDetail`, `listPutAwayCandidates`,
   `getPutAwayAggregate` (one grouped query per list, per-order for details).
8. **Admin routes** — new `src/routes/admin/outdatedWarnings.ts`:
   `GET /admin/outdated-warnings?resolved=&orderKind=` (join order no / part /
   supplier for display) and `POST /admin/outdated-warnings/resolve-order`
   `{orderKind, orderId, note}` → `{resolved: n}`; when n > 0 the route also
   re-runs the held completion (`retryAutoFinishPickingOrder` /
   `retryReceivingOrderClear` — kept in the route layer so `outdated.ts`
   does not import the flow modules). Register in `src/routes/admin/index.ts`.
9. **Backend tests** (node:test, mirror existing `*.test.ts` setup): check
   boundaries (exactly N months old, NULL limit, missing profile, invalid
   WWYY, 2-digit-year window), picking scan warns + row + event, put-away scan
   warns, finish 409 while unresolved, auto-finish / auto-clear held then
   completed after resolve, resolve idempotency.
   Run `pnpm --filter @warehouse/backend test` and `build` (tsc).

## Phase 2 — PDA (`apps/pda`)

10. Types + adapter (`services/types.ts`, `services/adapters/backendWarehouse.ts`):
    `outdatedWarning` on scan results; `outdatedWarningCount` on picking
    list/detail + put-away candidate/aggregate types.
11. Picking scan page + put-away detail page: when a scan response carries
    `outdatedWarning`, show the dismissible alert dialog (supplier, date code,
    limit; reuse the existing dialog pattern) and continue scanning. OCR path
    is the same response, no extra work.
12. Warning chip on picking list rows + order detail header, and on put-away
    list rows + detail header, when `outdatedWarningCount > 0`.
13. Finish 409 `unresolved_outdated_warnings` → show the server message with
    the count (verify the existing error toast path surfaces it). Put-away
    commit is not blocked; the held auto-clear completes after resolution.
14. New shared `components/OutdatedWarningDialog.vue` — the dismissible
    outdated-scan alert shown from the picking scan page + put-away detail
    page on a scan response carrying `outdatedWarning`.
14. `pnpm --filter @warehouse/pda test` + `nuxt prepare`.

## Phase 3 — admin (`apps/admin`)

15. `pages/suppliers/[code].vue`: "Outdated limit (months)" number field —
    empty = NULL = no check, default 12 on the create form.
16. New `pages/outdated-warnings.vue`: pending/resolved lists (SearchableSelect
    filters), resolve-order dialog with note; nav entry + pending-count badge
    in the layout; SSE `/admin/outdated-warnings` topic reload.
17. Warning chip + link to the warnings page on the picking order detail and
    receiving order detail pages.

## Phase 4 — docs + verification

18. Update `docs/backend/api-design.md` (new/changed endpoints + response
    fields), `docs/backend/event-catalog.md` (two new events),
    `docs/backend/schema-tables.md` (new column + table), the picking and
    put-away flows under `docs/app-docs/flows/` (overview/steps/ai-scope),
    `docs/app-docs/ai/feature-registry.md`, `docs/app-docs/ai/code-map.md`,
    and the `supplier_profiles` paragraph in `AGENTS.md`.
19. Full verify: backend test + tsc, PDA vitest + nuxt prepare, admin build.
