# Admin Excel export — data/renderer separation (plan)

Spec: `docs/superpowers/specs/2026-09-21-admin-excel-export-renderer-separation-design.md`

Pure code-motion refactor in `apps/backend`: no behavior, API, schema or
config change. Acceptance: the existing route tests pass **unmodified**.

1. `apps/backend/src/export/types.ts` — `ExportDocType` (`"shipper" |
   "picking-list"`), `RenderContext` (`warehouse?`, `supplierCode?`,
   `customerCode?`), `Renderer<Doc>` (`render(doc) → { fileName, buffer }`).
   Note in a comment: `warehouse` is reserved but **unwired** in this phase —
   `warehouse_config` has no warehouse identifier today; add one (config row
   or env) when the first warehouse-scoped variant lands.
2. `apps/backend/src/export/registry.ts` — `registerRenderer(docType,
   renderer, scope?)`, `resolveRenderer(docType, ctx)`. Registrations stored
   per docType in insertion order; resolution = first registration whose
   declared scope keys all equal the ctx values, else the one registration
   with no scope (the default). Throw if no default registered (programmer
   error, surfaces at boot/tests).
3. `apps/backend/src/export/shipper/model.ts` — `ShipperDocument`,
   `ShipperGroup`, `ShipperSlot` per spec §Document models.
4. `apps/backend/src/export/shipper/data.ts` —
   `loadShipperDocument(db, id, { finished }): Promise<ShipperDocument>`.
   Move verbatim from `src/routes/admin/receivingShipper.ts`: the `head`,
   `items`, `itemAllocs`/`orderAllocs`/`packageAllocs`/`relatedAllocs`
   queries, `SlotAlloc`/`toSlot`/`bySlotOrder`, the `allocsByItem` /
   `packageSlotsByPartKey` maps, part grouping, whole-order slot matching,
   `relatedAllocatedByGroup`, `slotCount`, per-group `blockItems` /
   `mergedSlots` / `allocatedTotal` / `totalQty` assembly. Throw the same
   `HTTPException(404, "receiving_order_not_found")`. Stop exactly where
   `aoa` building begins (current line 339); `ymd` moves too (applied to
   `head.deliveryDate` in the model). Keep the explanatory comments — they
   document behavior, not the move.
5. `apps/backend/src/export/shipper/render/default.ts` — `render(doc:
   ShipperDocument)`: the `aoa` building verbatim (title/date/total-ctn
   header rows, slot header rows, `pushGroupBlock`, `pushBlock`, group loop
   with blank separators), `!cols` widths, numeric `z = "#,##0"`,
   `XLSX.write`, filename (`shipper-` / `finished-shipper-`). Module
   bottom: `registerRenderer("shipper", { render })`.
6. Same split for the picking list from `src/routes/admin/pickingList.ts`:
   `export/picking-list/model.ts` (`PickingListDocument`,
   `PickingListGroup`, `PickingListAlloc` discriminated union), `data.ts`
   (`loadPickingListDocument(db, id)` — head query + 404
   `picking_order_not_found`, items, allocations, `allocsByItem`, part
   grouping, `allocKey`/`mergeAllocs`; the merged alloc rows are mapped to
   the `lot`/`receiving` union; `generatedAt` ISO string set here),
   `render/default.ts` (info block, header row, group/alloc row writing,
   UNALLOCATED / `(no allocation)` rows, separators, widths, write,
   filename) + self-registration.
7. Slim the two routes (`src/routes/admin/receivingShipper.ts`,
   `pickingList.ts`) to: param/`mode` parse → `load…Document(db, …)` →
   `resolveRenderer(docType, { supplierCode | customerCode from doc.head })`
   → `render(doc)` → `Response` with the existing headers. Each route
   imports its `render/default.js` (for the registration side effect),
   `data.js`, and `registry.js`. Keep the route header comments pointing at
   the specs; add one line pointing at `src/export/<doc>/`.
8. `apps/backend/src/export/registry.test.ts` — plain unit test (no DB):
   dummy renderers; assert scoped-beats-unscoped, warehouse-scope matching,
   non-matching scope skipped, throw without default.
9. Docs upkeep:
   - `docs/app-docs/ai/code-map.md`, `docs/app-docs/ai/feature-registry.md`
     — update the shipper / picking-list entries for the new
     `src/export/**` locations.
   - `docs/backend/api-design.md` — update the two endpoint rows if they
     reference `src/routes/admin/*.ts` internals.
   - Pointer note at the top of the two 2026-09-14 specs → this spec
     (layout code now lives in `src/export/`).
10. Verify, in order:
    - `docker compose up -d` (test DB needed),
      `pnpm --filter @warehouse/backend test` — full suite green, the two
      route test files **byte-unmodified** (`git diff --stat` shows no
      change to them).
    - `pnpm --filter @warehouse/backend build` (tsc).
    - Eyeball: hit `GET /admin/receiving-orders/:id/shipper` and
      `/admin/picking-orders/:id/picking-list` on the dev DB for one real
      order each and open the xlsx.
