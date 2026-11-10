# Flows

The app supports these warehouse flows. Each flow has an overview, a step-by-step operator guide, and an AI scope document.

| Flow | Purpose | Entry page | Operator guide | AI scope |
|------|---------|------------|----------------|----------|
| [Picking](./picking/overview.md) | Pick items from inventory to fulfill outgoing orders. | `/picking` | [Steps](./picking/steps.md) | [Scope](./picking/ai-scope.md) |
| [Label Printing](./label-printing/overview.md) | Print internal labels for finished picking orders before labeling. | `/label-printing` | [Steps](./label-printing/steps.md) | [Scope](./label-printing/ai-scope.md) |
| [Labeling](./labeling/overview.md) | Confirm labels are stuck on finished picking orders before measuring/verify. | `/labeling` | [Steps](./labeling/steps.md) | [Scope](./labeling/ai-scope.md) |
| [Receiving](./receiving/overview.md) | Confirm incoming shipments and create receiving-area stock. | `/receiving` | [Steps](./receiving/steps.md) | [Scope](./receiving/ai-scope.md) |
| [Put-away](./put-away/overview.md) | Move received goods from receiving area onto shelves. | `/put-away` | [Steps](./put-away/steps.md) | [Scope](./put-away/ai-scope.md) |
| [Measuring](./measuring/overview.md) | Verify and measure open shipping boxes, then close them. | `/measuring` | [Steps](./measuring/steps.md) | [Scope](./measuring/ai-scope.md) |
| [Verify](./verify/overview.md) | Second re-scan check of closed shipping boxes before shipping. | `/verify` | [Steps](./verify/steps.md) | [Scope](./verify/ai-scope.md) |
| [Goods Verify](./goods-verify/overview.md) | Verify goods at appropriate process points. | `/goods-verify` | [Steps](./goods-verify/steps.md) | [Scope](./goods-verify/ai-scope.md) |
| [Stock Search](./stock-search/overview.md) | Search inventory by supplier or item and see locations. | `/stock-search` | [Overview](./stock-search/overview.md) | [Scope](./stock-search/ai-scope.md) |
| [Ad-hoc Put-away](./ad-hoc-put-away/overview.md) | Put away items with no receiving order (old store stock, write-out returns). | `/ad-hoc-put-away` | [Steps](./ad-hoc-put-away/steps.md) | [Scope](./ad-hoc-put-away/ai-scope.md) |
| [Shelf Exchange](./shelf-exchange/overview.md) | Move stock between shelves (preview-first; allocated qty is immovable). | `/shelf-exchange` | [Steps](./shelf-exchange/steps.md) | [Scope](./shelf-exchange/ai-scope.md) |
| [Internal Transfer](./internal-transfer/overview.md) | Admin view of upstream-synced intra-warehouse stock moves — allocate them and link a delegated picking order (PDA picking is stage 2). | `/internal-transfer-orders` (admin) | [Steps](./internal-transfer/steps.md) | [Scope](./internal-transfer/ai-scope.md) |

Two more PDA queues ship without an operator guide yet — **Put-back**
(`/put-back`, cancelled-invoice stock returns, spec
`docs/superpowers/specs/2026-11-07-cancel-invoice-putback-design.md`) and
**Manual receiving** (`/manual-receiving`, CN no-PDF receipt path, spec
`docs/superpowers/specs/2026-10-27-manual-receiving-pda-design.md`); their
behavior is covered in those specs and the CN sections of the Receiving docs.
The CN receiving scan queue lives under Receiving (the `receiving-cn` flow).

## Common actions across flows

- **Scanning / label entry** — many flows use `useLabelScan` and `LabelScanReviewModal` to capture part numbers, quantities, dates, lot codes, and origins.
- **Issue reporting** — operators can report shortages, damages, or mismatches through `ReportIssueModal` / `PickingIssueReportModal`.
- **Status tracking** — each order/box/task has a status shown inline using `composables/useStatusBadge.ts` and recorded in `transaction_logs`.
