# Ingest API — RETIRED (2026-08-18)

The DocPal → warehouse server-to-server ingest HTTP API (`PUT`/`DELETE
/receiving-orders/:batchNo`, `PUT`/`DELETE /picking-orders/:id`,
`PUT /parts` + `DELETE /parts?wclItemNo=`, `PUT|DELETE /suppliers/:code`,
`PUT|DELETE /supplier-profiles/:supplierCode`,
`PUT|DELETE /sub-inventories/:orgId/:code`) was removed on 2026-08-18.
`apps/backend/src/routes/ingest.ts` is deleted; nothing is mounted at those
paths anymore.

It is replaced by **pull-based ElectricSQL sync** from the remote DocPal
Postgres master: a self-hosted Electric service replicates the 8 `demo.wms_*`
tables and the backend's sync consumer applies the changes locally.

- Design spec: `docs/superpowers/specs/2026-08-18-electric-sql-sync-design.md`
  (table mapping, column ownership, delete policy).
- Plan: `docs/superpowers/plans/2026-08-18-electric-sql-sync.md`.
- Consumer: `apps/backend/src/sync/consumer.ts` (master data) +
  `apps/backend/src/sync/orders.ts` (order tables), started from
  `apps/backend/src/server.ts` when `ELECTRIC_URL` is set and
  `ELECTRIC_SYNC != off`.
- Apply layer: `apps/backend/src/db/ingest.ts` — the former ingest domain
  functions (`upsertPart`, `upsertSupplier`, `deleteReceivingOrder`, …),
  kept and reused by the consumer; no longer behind HTTP.

This file is kept as a tombstone because other docs link to it. For the old
request/response contract, see git history.
