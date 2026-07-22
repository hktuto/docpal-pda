# Backend — Database Schema Reference

**Superseded (2026-07-21).** The table-by-table schema reference now lives in
[`schema-tables.md`](./schema-tables.md), which documents every table as a
field/type/description table and reflects the org_id redesign (no
`warehouse_code`, no `warehouse_sections`/`sub_inventories`, natural keys
`batch_no`/`order_no`, parts referenced by `part_no`). The design decisions
behind that redesign are recorded in
`docs/superpowers/specs/2026-07-21-schema-redesign-org-id-design.md`.

The typed source of truth remains `apps/backend/src/db/schema/*.ts`;
migrations live in `apps/backend/drizzle/` and auto-apply on server start.
All ids are `text` (UUID strings); timestamps are `timestamp` (UTC
wall-clock); `created_at`/`updated_at` are set by the app.

For the business concepts behind the schema (allocation, stock classes,
goods verify), see [`concepts.md`](./concepts.md).
