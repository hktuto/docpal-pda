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

A mismatch is a set of flat columns on the receiving invoice item itself
(`reported_mismatch`, `mismatch_reason`, `mismatch_qty`, `wrong_part_no`,
`mismatch_note`) — there is no separate mismatch table and no status or
reporter tracking.

| Action | Effect |
|--------|--------|
| Report | Sets the mismatch columns on the item (one active mismatch per item). |
| Edit | Overwrites the mismatch columns. |
| Confirm | Keeps the values and writes a transition log entry. |
| Cancel | Clears the mismatch columns. |

## Result

The reported mismatch is visible on the receiving detail's item row. All
four lifecycle actions are recorded in the transition log.
