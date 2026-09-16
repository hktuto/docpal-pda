# Admin receiving shipper — related-order allocated qty cell (plan)

Spec: `docs/superpowers/specs/2026-09-16-admin-receiving-shipper-related-allocated-design.md`

1. `apps/backend/src/routes/admin/receivingShipper.ts`
   - Add a live-mode query `relatedAllocs`:
     `WITH related_orders AS (SELECT DISTINCT pi.picking_order_id FROM allocations a JOIN picking_items pi … LEFT JOIN receiving_invoice_items rii ON rii.id = a.receiving_invoice_item_id LEFT JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id WHERE a.receiving_order_id = :id OR ri.receiving_order_id = :id) SELECT pi.part_no AS "demandPartNo", SUM(a.qty)::int AS qty FROM allocations a JOIN picking_items pi … WHERE pi.picking_order_id IN (SELECT …) GROUP BY pi.part_no`.
   - Per group, sum rows matching the part-key rule (demand part_no = item part_no OR wcl_item_no) → `relatedAllocated`.
   - Replace the `shelf` computation (and the `suggestions` /
     `computeItemShelfSuggestions` / `putAwayConfig` usage, the
     covered/fully-allocated tracking) with `relatedAllocated`; pass it into
     `pushGroupBlock` in place of `shelf` (rename the param; write a number,
     blank when 0). Update the block-layout comments.
2. `apps/backend/src/routes/admin/receivingShipper.test.ts`
   - Update the two live-mode tests' expected rows; add the stock-sourced /
     unrelated-order test (insert lots + allocation rows directly).
3. Docs: `docs/backend/api-design.md` (`GET /admin/receiving-orders/:id/shipper`
   row), `docs/app-docs/flows/receiving/ai-scope.md` (shipper bullet),
   pointer note at the top of the 2026-09-14 spec.
4. Verify: `pnpm --filter @warehouse/backend test` (shipper tests at
   minimum), `pnpm --filter @warehouse/backend build`, and generate the real
   shipper for `01M27M7XNQ6W19F6CA000GRB5J` against the dev machine's copy
   of the live DB to eyeball the numbers.
