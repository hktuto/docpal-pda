# Internal Transfer Steps (Admin)

1. **Find the order** — Internal Transfers list; filter by status
   (`pending` when new), search order no / customer. The 🔗 marker shows a
   delegated picking order is linked.
2. **Open the detail** — header shows from_/to_ partitions, status,
   allocation coverage (`unallocated / partial / allocated`), item lines with
   allocated qty.
3. **Re-allocate** (status pending/allocated/picking) — wipes and rebuilds
   the order's allocations from the `from_` partition. Manual pins survive.
   Repeatable; idempotent when nothing changed.
4. **Link a delegated picking order** (status pending/allocated) — search
   open picking orders; suggestions are already filtered to the `to_` org
   (server rejects mismatches with 409 `org_mismatch`). Unlink returns the
   transfer to the put-away branch.
5. **Adjust allocations manually** — 🔍 on an item line opens the
   availability dialog (stock + dock rows at the `from_` partition) to pin
   qty against a specific lot/receiving line; ✗ removes a row (transient —
   the next Re-allocate may re-create it).

Stage 2 (not built): PDA transfer queue + shelf picking; finish moves the
picked stock to `to_` (feed the linked picking order) or creates a put-away
task.
