# ElectricSQL sync — implementation plan (2026-08-18)

Spec: `docs/superpowers/specs/2026-08-18-electric-sql-sync-design.md`
(all decisions recorded there; this plan sequences the work).

Phase order follows the spec's transition plan: local schema alignment
first (transport-independent, works with the current ingest API), then
Electric infra + consumers, then ownership enforcement, then retirement of
the ingest HTTP routes.

**Input still needed from Sean (still pending 2026-08-18):** the defaulting
rule that assigns `sub_inventory_code` to every `receiving_invoice_items`
row at apply time. The interim rule shipped: item keeps a NULL pair →
allocation skips it and the stub `applyItemSubInventoryDefault` in
`src/db/ingest.ts` logs a warning (surfaced, never silently allocated).

---

## Phase 1 — Local schema alignment (no Electric, no remote changes) — DONE 2026-08-18

### 1. Migration (`apps/backend`)

Edit Drizzle schema, then `pnpm --filter @warehouse/backend db:generate`:

- `src/db/schema/receiving.ts`
  - `receivingOrders`: drop `subInventoryCode` column + `subInvFk`
    composite FK (introduced in `drizzle/0000_nasty_wrecker.sql:182,452`).
    Keep `orgId` NOT NULL default 2.
  - `receivingInvoices`: drop `subInventoryCode` + `subInvFk`
    (`0000:171,449`).
  - `receivingInvoiceItems`: `lineQty` → nullable (`0000:140`); add
    `orderData: jsonb("order_data")` (passthrough, mirrors
    `additional_data`).
- `src/db/schema/master.ts` — `parts`: drop `defaultCoo` (`0000:46`).
- `src/db/schema/picking.ts` — `pickingItems`: `lineId`, `lineNumber`,
  `shipmentNumber` → nullable (`0000:218-220`).
- Regenerates migration + `drizzle/meta/00XX_snapshot.json`. The
  sync_events trigger (`0000:568-579`) uses `to_jsonb(NEW/OLD)` — no
  trigger change needed for dropped columns.

### 2. Allocation engine (`src/db/allocate.ts`)

`loadReceivingSources()` (`:186-220`) currently matches dock stock on the
ORDER pair (`ro.org_id` / `ro.sub_inventory_code`, join `sub_inventories`
at `:192`, location match `:213-219`, customer segregation `:220`).

- Switch the `sub_inventories` join and both match clauses to the ITEM
  pair (`rii.org_id`, `rii.sub_inventory_code`).
- Item pair NULL → source row skipped + counted; `allocateAll` result/logs
  report skipped count (the interim rule above).
- Update the header comment at `:25-31`.
- Tests: `allocate.test.ts` (`:263`, `:359` raw INSERTs + fixtures that
  set order-level pairs) — move pairs onto items.

### 3. Put-away (`src/db/putaway.ts`, `src/db/putawaytasks.ts`)

- `orderPair()` (`:138-141`) reads the order pair — replace with an
  item-derived pair: `SELECT DISTINCT org_id, sub_inventory_code FROM
  receiving_invoice_items rii JOIN receiving_invoices ... WHERE order =
  :id`. Uniform pair → use it; mixed/NULL → NULL (staging/shelf box pair
  stamps `:120`, `:130-131`, `:732-733` accept NULL; the lot materializer
  already stamps lots with the BOX's pair).
- `listPutAwayCandidates` (`:252`, `:269`) and `getPutAwayAggregate`
  (`:379-383`) read the order pair — same derivation. Shelf suggestion
  call `computeShelfSuggestions(db, partNos, order.orgId,
  order.subInventoryCode)` (`:444`) — per-item suggestion already exists
  in the aggregate; pass the ITEM's pair per suggestion instead of one
  order pair.
- `putawaytasks.ts` `createPutAwayTaskTx()` (`:29-39`) stamps the task's
  denormalized pair from the order pair — stamp the derived uniform pair,
  NULL when mixed (task list reads its own columns `:67-68`, `:85-86`, so
  no other change).
- Tests: `putaway.test.ts:89,126,767-774`, `putawaytasks.test.ts:56,64-65,220,227`.

### 4. Ingest domain (`src/db/ingest.ts`)

- `upsertReceivingOrder`: remove `subInventoryCode` from
  `IngestReceivingOrder` (`:42-51`), the 400 validation (`:221`), INSERT
  (`:370`), existing-row SELECT/diff/UPDATE (`:388-417`). Remove
  invoice-level `subInventoryCode` (`:81`, `:290`, `:306`, `:429`, `:473`,
  `:482`, `:489`).
- Items: `lineQty` optional (`:60`); relax `:235-236` validation to accept
  null; reconcile/UPDATE paths (`:316`, `:436`, `:507`, `:514`, `:526`)
  null-safe (`IS NOT DISTINCT FROM` semantics). Add `orderData`
  passthrough alongside `additionalData`. **Defaulting rule hook:** after
  item validation, apply the sub-inventory defaulting rule (task input
  from Sean; interim = leave NULL + warn).
- `upsertPickingOrder`: `IngestPickingItem.lineId/lineNumber/
  shipmentNumber` optional (`:106-108`); relax `validatePickingBody`
  (`:627-631`); reconcile diffs (`:801-803`) compare null-safely (note
  `lineId` bigint round-trips as string).
- `upsertPart`: remove `defaultCoo` (`:901`, `:961`, `:969`, `:982`).
- Tests: `ingest.test.ts` (`:47`, `:90-103`, `:228-257`, `:341+`),
  `ingest-masterdata.test.ts` (`:50`, `:56`, `:80-86`, `:106`, `:321`).

### 5. Receiving flow null-safety (`src/db/receiving.ts`, `src/routes/receiving.ts`)

`line_qty` NULL handling:

- `confirmReceivingArrival` sets `received_qty = rii.line_qty` (`:85`) —
  NULL line_qty → leave received_qty 0 and count the row as
  needs-attention in the response.
- Over-receipt guard `qty > item.lineQty - item.receivedQty` (`:248`,
  `:286`) — NULL lineQty → skip the guard (scan allowed; mismatch flow is
  the safety net).
- `remainingItems` filter `put_away_qty < line_qty`
  (`routes/receiving.ts:70`) — NULL drops the row today; make it
  `line_qty IS NULL OR put_away_qty < line_qty`.
- Drop order/invoice `subInventoryCode` from list/detail SELECTs and
  response shapes (`:40`, `:67`, `:104`, `:129`, `:175`, `:198`, `:244`,
  `:265-266`) and the `partDefaultCoo` payload (`:227`, `:291`).
- `labels.ts`: `ORDER BY pi.line_number` (`:236`) → `NULLS LAST`;
  `rii.line_qty AS "qty"` (`:176`) — NULL-safe label qty (COALESCE 0 or
  blank; pick blank and let the print template show empty).
- `putaway.ts:339,413` remaining-qty formulas already avoid lineQty — verify.

### 6. Frontend contract updates

- `apps/web/services/types.ts`: drop order/invoice `subInventoryCode`
  (`:39`, `:66`, `:84`, `:565`), `defaultCoo` (`:114`, `:811`); make
  `lineQty`/line ids nullable (`:96`, `:244`, `:360-362`, `:500`).
- Web pages/components with `lineQty` arithmetic — null-guard:
  `pages/receiving/[id].vue:198,311`, `components/ReportIssueModal.vue:168`,
  `components/receiving/ReceivingItemsTab.vue:20`,
  `ReceivingScanReviewModal.vue:42`, `ReceivingScanMultiItemModal.vue:132`,
  `components/put-away/PutAwayLotsPanel.vue:22`. Display "—" for NULL
  expected qty. Stock-search CSV export drops the COO column
  (`pages/stock-search/index.vue:150`).
- `apps/admin/utils/flowApi.ts` types (`:36-38`, `:75`, `:89`, `:109`,
  `:118`, `:161`); `pages/receiving/[id].vue:269` (order/invoice sub-inv
  display — remove), `:174,176,312,394` (lineQty null-guards);
  `utils/entities.ts:100` (parts CRUD `defaultCoo` field — remove);
  i18n keys `admin.fields.defaultCoo` in
  `layers/i18n/i18n/locales/{en-US,zh-CN,zh-HK}.ts` — remove.
- `apps/web-presentation/` mirrors the API contract (own PGlite schema
  `db/schema.ts:30`, `db/init.ts:27`, `db/stockSearch.ts:104,128`) —
  update in the same pass so the prototype keeps compiling.

### 7. Seeds

- `scripts/gen-seed-demo-scenario.mjs`: `receiving_orders` sheet — stop
  emitting `subInventoryCode` (`:31`, `:273-286`); instead emit it on
  `receiving_items` (`:43`, `:312-332`) using the old order value, so the
  demo dataset exercises item-level pairs. Keep the xlsx column (rename
  header note) or drop it — pick drop, regenerate xlsx via the script's
  write mode. Parts: `defaultCoo` already hardcoded null (`:395`, `:410`)
  — remove the field.
- `scripts/gen-seed-real-data.mjs`: remove `default_coo` (`:103`);
  regenerate `src/db/seed-parts-data.json` (~131k rows; will now match the
  remote `wms_parts` shape minus IDs).
- `src/db/seed.ts` (`:54`, `:236-240`, `:444`, `:465`),
  `seed-demo-scenario.ts` (regenerate), `seed-real-data.ts` (`:911-936` —
  unused arrays, but keep them compiling), `seed-order-210726.ts` (unused;
  keep compiling).
- Web adapter test fixtures:
  `apps/web/services/adapters/backendWarehouse.test.ts:120,134-135,1066`.

### 8. Docs

`docs/backend/schema-tables.md`, `api-design.md`, `ingest-api.md`,
`concepts.md` (§6 allocation), `README.md`/`AGENTS.md` (schema contract
paragraph: order-level sub-inventory is gone; `parts.default_coo` gone),
`docs/app-docs/flows/receiving/*` + `picking/*` (ai-scope + steps where
they mention the order-level store or COO prefill).

### Phase 1 verification — IN PROGRESS (backend suite re-run on the fresh squashed baseline pending)

- `pnpm --filter @warehouse/backend test` (needs Postgres up).
- `pnpm --filter @warehouse/backend build` (tsc) + web/admin `nuxt prepare`.
- `pnpm --filter @warehouse/backend db:seed` against a scratch DB; walk
  receiving → put-away → picking in the PDA UI with the demo dataset.

---

## Phase 2 — Electric service + master-data consumer — DONE 2026-08-18

### 1. Electric service (DONE — verified against the real remote 2026-08-18)

- `electricsql/electric:1.7.11` (latest stable; `@electric-sql/client`
  1.5.26) added to both compose files. Dev: profile `sync`, host port
  3101, `ELECTRIC_INSECURE=true`; prod: internal-only, `ELECTRIC_SECRET`
  required, backend `depends_on` it and gets `ELECTRIC_URL`/`ELECTRIC_SECRET`.
  Remote DSN via `DOCPAL_SYNC_DATABASE_URL` in the root `.env`.
- **No manual remote DDL needed**: Electric auto-creates and manages its
  own publication/slot when shapes are first requested
  (`ELECTRIC_MANUAL_TABLE_PUBLISHING` stays false — the `docpal` role is
  superuser). With `ELECTRIC_REPLICATION_STREAM_ID=warehouse` these are
  `electric_publication_warehouse` + `electric_slot_warehouse` — our own
  objects, satisfying the "we create own publication + slot" decision.
  `wms_supplier_profiles` is excluded simply by never requesting a shape
  for it. Smoke test verified: connected to the remote, shape on
  `demo.wms_suppliers` streamed rows, publication auto-added the table
  and set replica identity. (DocPal still drops the old `docpal_cdc`
  objects later.)

### 2. Consumer (`apps/backend/src/sync/`) — DONE

Note as implemented: master-data upserts still key on the NATURAL keys via
the `src/db/ingest.ts` functions (Electric `replica: "full"` makes every
message carry the whole row) and adopt the remote `id` as the local PK on
insert; `sub_inventories` applies through dedicated SQL so the local-only
`customer_code` is never touched. The plan's "no need for `replica=full`"
remark applies to the order tables only (phase 4, `replica: "default"`).

- `sync_checkpoints` table (new migration): `(table_name text PK, offset
  text, handle text, updated_at)` — persist `stream.offset` +
  `stream.shapeHandle` after each applied batch; on boot pass them back
  to the `ShapeStream` constructor to resume. On a `must-refetch`
  control message: delete the checkpoint and resync from `offset=-1`.
- `consumer.ts`: one `ShapeStream` (`@electric-sql/client` 1.5.26) per
  master table to start: `demo.wms_org_info` → `sub_inventories`,
  `demo.wms_parts` → `parts`, `demo.wms_suppliers` → `suppliers`.
  - **Apply keys on the remote `id`** (adopted as the local PK): Electric
    messages always carry the PK — inserts carry the full row, updates
    PK + changed columns (default replica — no need for `replica=full`),
    deletes PK only. Natural-key upsert is NOT needed for identity; the
    natural-key uniqueness constraints still guard data quality.
  - Mapping layer: `uuid → text` (verbatim), `numeric → integer`
    (`org_id`, `organization_id`), `timestamptz → timestamp`, snake_case
    columns as-is (local columns are snake_case too), drop remote-only
    workflow columns; partial UPDATEs write only the columns present in
    the message.
  - Apply wrapped in `suppressSyncEvents`; master-data changes need no
    `allocateAll`.
  - Deletes: apply unless FK-referenced; on FK rejection log + skip
    (mirrors `409 cannot_delete_referenced`).
  - Initial snapshot: the shape's initial `insert` flood re-keys master
    tables onto remote IDs naturally (nothing FK-references these PKs).
- Boot wiring: consumer starts after migrations; disabled in tests
  (`ELECTRIC_SYNC=off` default in test env) and when `ELECTRIC_URL` is
  unset. Log lag + applied counts periodically.

### Phase 2 verification — IN PROGRESS (initial parts snapshot ~131k rows applies row-by-row, ~28 min one-time; live convergence spot-checks against the remote pending)

- Point dev compose at the remote DB; watch parts/suppliers/org_info
  converge (count + spot-check rows; local IDs become remote IDs).
- Update a part description remotely (or ask DocPal to) → appears locally
  within seconds; PDA stock search shows it.

---

## Phase 3 — Ownership enforcement — DONE 2026-08-18

As implemented: the trigger function is `enforce_remote_owned_columns()` (not
`enforce_column_ownership()`), shipped as custom SQL in the squashed
`drizzle/0000_baseline.sql` together with the `wms_sync_consumer` role (8
per-table BEFORE UPDATE triggers; INSERT/DELETE unrestricted;
`delivery_date`/`date_code` deliberately shared). The apply layer sets
`SET LOCAL app.upstream_write = 1` so the ingest domain functions pass the
triggers regardless of role; test fixtures use the `upstreamWrite` helper in
`src/db/test-helper.ts`. Admin CRUD keeps editing — the trigger rejects and
the UI shows the error (the "simplest" option above).

- New migration: DB role `wms_sync_consumer` (LOGIN, password from env);
  consumer connects with it.
- Trigger function `enforce_column_ownership()` per synced table: UPDATE
  from any role except `wms_sync_consumer` that changes a remote-owned
  column → RAISE EXCEPTION. Remote-owned column lists per spec §"Column
  ownership". Local-owned columns untouched by trigger.
- Backend keeps full rights on local-owned columns; admin CRUD for
  parts/suppliers/sub-inventories (remote-owned fields) becomes
  read-only or is removed — decide per page; simplest: admin keeps
  editing, trigger rejects, UI shows the error. (DocPal is the master;
  local edits would drift anyway.)

## Phase 4 — Order tables consumer — code DONE 2026-08-18 (`src/sync/orders.ts`; interim surfacing = loud `console.warn` skip, no issues-page entry)

- Extend `src/sync/consumer.ts` to the four order tables.
  - Headers: upsert by remote `id` verbatim (picking) / `batch_no`
    natural key (receiving, whose remote `id` is also adoptable — prefer
    remote id for uniformity).
  - Items: per-row apply (insert/update/delete by remote item `id`) —
    the ingest whole-document reconcile is NOT reusable here; new small
    apply functions in `src/db/ingest.ts` (keep them next to the
    document-level ones).
  - Apply-time hooks: sub-inventory defaulting rule (phase 1 task 4),
    `allocateAll` best-effort after any change to an open order, all
    under `suppressSyncEvents`.
  - Deletes of guarded rows (work started): reject + surface. Interim
    surfacing = `console.error` + admin-visible note; a proper
    issues-page entry can follow (deferred per spec decision).
- Verification **(PENDING — live end-to-end run against the remote)**:
  DocPal pushes a demo order remotely → PDA sees it, can
  receive/pick it, allocation behaves; DocPal edits qty → re-allocation;
  DocPal deletes a pending order → gone locally; in-flight delete →
  guarded.

## Phase 5 — Retire the ingest HTTP API — DONE 2026-08-18

As implemented: `src/routes/ingest.ts` + route mount removed; the planned
rename of `src/db/ingest.ts` to `src/db/upstream-apply.ts` was NOT done (file
kept as-is — it is the consumer's apply layer). `docs/backend/ingest-api.md`
became a short retired-notice tombstone (a full sync runbook — slot lag,
replay, re-snapshot — is still to write). `AGENTS.md`, `docs/backend/README.md`
+ `api-design.md` + `event-catalog.md`, and app-docs (`ai/feature-registry.md`,
`ai/code-map.md`, `flows/receiving/ai-scope.md`, `flows/picking/ai-scope.md`)
updated.

---

## Risk notes

- **Dormant remote slot** retains WAL until DocPal drops it — remind them
  at phase 2 kickoff.
- **Remote writes to workflow columns** would clobber local state; the
  phase-3 triggers only protect the reverse direction. Get DocPal's
  written confirmation before phase 4.
- **Seed vs sync duality:** while both exist, `WAREHOUSE_SEED` demo data
  and remote master data can diverge in IDs; after phase 2 initial
  snapshot the remote IDs win for master tables. Tests keep using
  `resetAndReseed` with local fixtures (consumer off in tests).
