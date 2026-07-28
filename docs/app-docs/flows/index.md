# Flows

The app supports these warehouse flows. Each flow has an overview, a step-by-step operator guide, and an AI scope document.

| Flow | Purpose | Entry page | Operator guide | AI scope |
|------|---------|------------|----------------|----------|
| [Picking](./picking/overview.md) | Pick items from inventory to fulfill outgoing orders. | `/picking` | [Steps](./picking/steps.md) | [Scope](./picking/ai-scope.md) |
| [Receiving](./receiving/overview.md) | Confirm incoming shipments and create receiving-area stock. | `/receiving` | [Steps](./receiving/steps.md) | [Scope](./receiving/ai-scope.md) |
| [Put-away](./put-away/overview.md) | Move received goods from receiving area onto shelves. | `/put-away` | [Steps](./put-away/steps.md) | [Scope](./put-away/ai-scope.md) |
| [Measuring](./measuring/overview.md) | Measure and pack shipping boxes for finished picking orders. | `/measuring` | [Steps](./measuring/steps.md) | [Scope](./measuring/ai-scope.md) |
| [Verify](./verify/overview.md) | Second re-measure check of shipping boxes before shipping. | `/verify` | [Steps](./verify/steps.md) | [Scope](./verify/ai-scope.md) |
| [Goods Verify](./goods-verify/overview.md) | Verify goods at appropriate process points. | `/goods-verify` | [Steps](./goods-verify/steps.md) | [Scope](./goods-verify/ai-scope.md) |
| [Stock Search](./stock-search/overview.md) | Search inventory by supplier or item and see locations. | `/stock-search` | [Overview](./stock-search/overview.md) | [Scope](./stock-search/ai-scope.md) |

## Common actions across flows

- **Scanning / label entry** — many flows use `useLabelScan` and `LabelScanReviewModal` to capture part numbers, quantities, dates, lot codes, and origins.
- **Issue reporting** — operators can report shortages, damages, or mismatches through `ReportIssueModal` / `PickingIssueReportModal`.
- **Status tracking** — each order/box/task has a status shown inline using `composables/useStatusBadge.ts` and recorded in `transaction_logs`.
