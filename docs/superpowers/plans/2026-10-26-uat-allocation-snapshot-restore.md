# UAT allocation snapshot and restore implementation plan

1. Add snapshot batch/row Drizzle tables, export them, include them in dev reset, and generate a migration.
2. Implement transactional daily capture and latest-batch restoration in `src/db/allocationSnapshot.ts`.
3. Restore by stable IDs/business keys, validate status/locks/qty/availability, preserve manual work, and reuse allocation UUIDs for idempotency.
4. Add reserve/release ledger and audit records, global lot/item counter reconciliation, order status refresh, reports, and allocation SSE events.
5. Serialize restoration with the existing allocation runner and add admin-only snapshot/restore endpoints.
6. Add the opt-in 17:45/08:00 local-time scheduler and environment documentation.
7. Add node:test coverage for changed IDs, every source type, counters, conflicts, validation failures, idempotency, routes, and schedule calculation.
8. Update backend and app-docs references, then run backend typecheck, full tests, and real endpoint/database verification.
