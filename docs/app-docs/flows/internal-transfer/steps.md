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
6. **Confirm** (pending → allocated) — the PDA queue gate. Unconfirm returns
   the order to admin-only.

## PDA steps (stage 2)

1. **Queue** — Internal Transfer tile; confirmed orders (allocated/picking/
   issue) plus finished unlinked orders that still need shelving.
2. **Pick** — open an order; each item shows its remaining reservations as
   pick guidance (shelf / box / date-code, or receiving batch/ctn). Scan the
   item's QR label (hardware scanner or the camera FAB — decoded through the
   backend scan authority; the label qty pre-fills the prompt, its batch
   fields ride along) or tap Pick and enter the qty — capped at the
   reservation. A shelf scan first sets the pending shelf
   (pickingShelfScan require-match). Remove (✗) un-picks a package.
3. **Report issue** — record a shortage (reason + actual qty + note);
   picking continues and a recorded issue satisfies the finish guard.
4. **Finish** — linked: the picked stock lands unshelved at the delegated
   order's location and its allocation re-runs immediately (cross-dock; the
   page links to the delegated order). Unlinked: the stock waits as packages.
5. **Shelve** (unlinked, after finish) — the finished order re-enters the
   queue as put-away pending; scan a shelf, then Shelve each part group —
   packages merge onto the destination shelf lot-by-lot until the task
   completes.
