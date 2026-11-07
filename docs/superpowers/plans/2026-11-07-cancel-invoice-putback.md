# Cancel-Invoice Ingest + Put-Back Tasks — Implementation Plan

Date: 2026-11-07
Spec: `docs/superpowers/specs/2026-11-07-cancel-invoice-putback-design.md`

## Steps (all landed)

1. [x] Schema `src/db/schema/cancel.ts` — `cancel_records`, `put_back_tasks`,
   `put_back_task_items` (unique source dedupe, package-level put-back dedupe);
   migration `drizzle/0059_*`; tables added to seed `ALL_TABLES`.
   `cancel_invoice` / `cancel_invoice_tn` stay externally managed (raw SQL,
   `42P01` tolerated) — cloned into the local dev DB from 192.168.3.99 for testing.
2. [x] `picking.ts`: `releaseAllocationsForItemsTx` shared helper extracted from
   `overridePickingOrderStatus` (item-scoped, nullable actor); `cancelled` added to
   `PICKING_ORDER_STATUSES`; `recomputePickingItem` keeps cancelled items cancelled.
3. [x] `adhocPutaway.ts`: lot find-or-create + credit extracted as exported
   `creditLotTx` (shared with put-back completion).
4. [x] `db/cancelInvoice.ts`: row fetch (LEFT JOIN dedupe, no cutoff — late-synced
   rows with old timestamps are still applied), `processCancelSourceRow`
   (match → release → un-box + empty-box delete → put-back task/items → cancel
   items → close order when all items cancelled → audit + SSE), `cancel_records`
   upsert with outcome/status/source_ts, admin `listCancelRecords`.
5. [x] `jobs/cancelInvoiceSync.ts` (receivingCnSync pattern) + config env
   `CANCEL_INVOICE_SYNC` / `CANCEL_INVOICE_SYNC_INTERVAL_SEC`, wired in `server.ts`.
6. [x] `db/putback.ts` (list/detail/complete with lot credit + ADJUST ledger +
   shelf-box verify invalidation) + `routes/putback.ts` + `routes/admin/cancelRecords.ts`;
   `put-back` flow step (`FLOW_STEPS`), `TASK_ASSIGNMENT_FLOWS` + admin FLOWS.
7. [x] PDA: service types/adapter, `useFlowSteps` default, `put-back` home tile,
   `pages/put-back/index.vue` + `[id].vue` (shelf scan fallback + complete),
   `badgeClass` cancelled → danger.
8. [x] Admin: `pages/cancel-records.vue` (filters + SSE auto-refresh), nav link,
   `flowApi.listCancelRecords` + types, picking status lists + override modal +
   flow-config step, `task-assignments` put-back tab.
9. [x] i18n: `putBack.*`, `status.picking.cancelled`, `cancelRecords.*`,
   `taskAssignments.flows.put-back`, `admin.navLinks.cancelRecords`, flow-config
   step label — en-US / zh-HK / zh-CN.
10. [x] Tests: `cancelInvoice.test.ts` (7) + `putback.test.ts` (4) on cloned-table
    fixtures; status-override invalid-status example switched to `closed`. Full
    backend suite green; PDA build/tests green; admin build green.
11. [x] Docs: api-design.md, event-catalog.md, schema-tables.md, AGENTS.md queue
    list, app-docs registry/code-map, UAT functions + CR entry.
