# Receiving Mismatch Handling

A mismatch occurs when the physical shipment does not match the expected invoice.

## Types of mismatch

- **Shortage** — fewer items arrived than expected (`qty_mismatch`).
- **Overage** — more items arrived than expected (`over_shipment`).
- **Wrong item** — a different part arrived (`wrong_part`).
- **Damage** — items arrived damaged (`damaged`).
- **Quality rejection** — items failed QA (`quality_rejection`).
- **Not found** — the line is completely missing (`not_found`).

## How to report

1. On the receiving detail, tap the mismatch/issue action for the affected line.
2. Select the mismatch reason.
3. Enter the actual quantity or notes (required for `wrong_part`).
4. Submit.

## Storage and lifecycle

Mismatches are stored in the `receiving_item_mismatches` table.

| Status | Meaning |
|--------|---------|
| `pending` | Reported and awaiting a second user's approval. |
| `confirmed` | Approved by another user; the effective received quantity is final. |
| `cancelled` | Rejected by another user; the line reverts to its previous received quantity. |

Only the reporter can edit a pending mismatch. A different user must confirm or cancel it.

## Result

The mismatch updates `receiving_invoice_items.received_qty` to the effective quantity and re-evaluates the parent receiving order's `clear`/`in_hand` status. Confirmed and cancelled mismatches are recorded in the transition log.
