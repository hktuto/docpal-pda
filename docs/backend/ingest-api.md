# Ingest API — RETIRED (2026-08-18)

The DocPal → warehouse server-to-server ingest HTTP API (`PUT`/`DELETE
/receiving-orders/:batchNo`, `PUT`/`DELETE /picking-orders/:id`,
`PUT /parts` + `DELETE /parts?wclItemNo=`, `PUT|DELETE /suppliers/:code`,
`PUT|DELETE /supplier-profiles/:supplierCode`,
`PUT|DELETE /sub-inventories/:orgId/:code`) was removed on 2026-08-18.
`apps/backend/src/routes/ingest.ts` is deleted; nothing is mounted at those
paths anymore.

The ElectricSQL sync service that replaced it was removed on 2026-08-20.
Upstream sync is now performed by an external service, which can either:

- Consume the outbound table-change feed at `GET /sync-events?since=` to learn
  what changed in the warehouse backend.
- Write into the backend through the reusable apply layer in
  `apps/backend/src/db/ingest.ts` (`upsertPart`, `upsertSupplier`,
  `upsertReceivingOrder`, `upsertPickingOrder`, guarded deletes, …). These
  functions run with `app.sync_events_off = 1` so upstream-originated writes
  do not echo back into `sync_events`.

This file is kept as a tombstone because other docs link to it. For the old
request/response contract, see git history.
