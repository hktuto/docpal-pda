# OCR-Assisted Picking from Receiving Area

## Context

This demo warehouse PDA app tracks receiving orders, put-away, inventory lots, allocations, and picking orders. Operators currently pick items manually from the picking order detail page. This design adds an OCR-assisted picking shortcut from the **receiving order detail page** so an operator can scan a physical label in the receiving area and immediately apply it to a linked picking order.

Real OCR (Google ML Kit / PaddleOCR) is out of scope for the first iteration. The demo mocks the OCR step with predefined label presets.

## Goal

Let an operator, while viewing a receiving order detail page, tap a scan button, choose a predefined label, and have the system automatically:

1. Parse the label into part number, date code, lot code, origin country, and quantity.
2. Find matching stock still in the receiving area.
3. Find linked picking orders that still need that stock.
4. Apply the picked quantity to the correct picking order.

## User Flow

### Trigger

A floating **scan icon button** (icon only, no text) appears on the receiving order detail page (`/receiving/{id}`) only when:

- The receiving order status is `in_hand`.
- The receiving order has linked picking orders with outstanding requirements for parts still available in the receiving area.

### Modal States

Tapping the button opens a centered modal with four possible states:

| State | When It Appears | User Action |
|---|---|---|
| **Preset picker** | Initially | Select one of the predefined labels that simulates an OCR capture. |
| **Single match** | Exactly one picking order can accept the scanned qty | System auto-applies the pick and shows a summary. |
| **Multiple matches** | Two or more picking orders can accept the scanned qty | User chooses which picking order to apply. |
| **No match** | No candidate picking order or no matching receiving stock | Error message; user closes and retries or handles manually elsewhere. |

After a successful pick, the modal closes and the receiving detail page refreshes.

## OCR Text Normalization

Before matching, the parsed OCR fields go through a lightweight normalization step. This keeps the matching logic exact while handling common OCR misreadings:

- Trim whitespace.
- Uppercase all text.
- Collapse multiple spaces into one.
- For date codes and lot codes (fields expected to be mostly numeric), optionally map common OCR digit confusions: `O` → `0`, `I` → `1`, `l` → `1`, `Z` → `2`, `S` → `5`.
- Part numbers and origin countries receive base normalization only, so values like `KOA-103` are not altered.

For the first demo, normalization is applied to the mock presets as well so the behavior is consistent. Future real-OCR work can expand this normalization or replace it with confidence-based fuzzy matching.

## Matching Rules

Normalized OCR result: `{ partNo, dateCode, lotCode, originCountry, qty }`.

### Step 1: Find receiving lot candidates

Query `receiving_invoice_items` linked to the current receiving order where:

- `part.partNo === parsed.partNo`
- `receivedQty - pickedQty - putAwayQty - allocatedQty > 0`
- `dateCode` matches (null matches null only — no wildcard)
- `lotCode` matches (null matches null only)
- `originCountry` matches (null matches null only)

If no candidate, outcome is **No match**.

### Step 2: Verify quantity fits receiving stock

Scanned qty must be ≤ available qty of the matched receiving item. If not, outcome is **No match**.

### Step 3: Find picking order candidates

Find linked picking orders with a `picking_item` for the same part where:

- `qty - pickedQty - allocatedQty ≥ scanned qty`

If 0 candidates → **No match**.  
If 1 candidate → **Single match**.  
If 2+ candidates → **Multiple matches**.

## Apply Pick Operation

When a candidate is chosen (automatically or by the user):

1. Insert an `allocations` record linking the selected `picking_item` to the matched `receiving_invoice_item` with `qty = scanned qty`.
2. Call `materializeReceivingAllocation(...)` to create a dedicated receiving-area `inventory_lots` row.
3. Call `confirmAllocationPicked(...)` to:
   - decrement the inventory lot,
   - increase `receiving_invoice_items.pickedQty`,
   - increase `picking_items.pickedQty`,
   - remove or reduce the allocation.

This reuses the existing allocation/pick transaction logic unchanged.

## Mock OCR Layer

Because real camera/OCR is deferred, the demo uses a mock layer:

- `composables/useMockOcr.ts` exposes predefined label presets derived from seed data.
- Each preset contains raw text and pre-parsed fields.
- The modal's preset list is the stand-in for "camera capture + OCR".

Future iteration replaces this composable with a real OCR adapter that returns the same `{ partNo, dateCode, lotCode, originCountry, qty }` shape.

## Proposed File Structure

```text
composables/
  useMockOcr.ts       # mock presets + parser
  useOcrPicking.ts    # match + apply flow orchestration
db/
  ocrPicking.ts       # DB queries for candidates and apply logic
components/
  OcrScanModal.vue    # modal UI for preset picker / results
pages/
  receiving/[id].vue  # add floating scan button + modal
```

## Error Cases

| Error | Message to User |
|---|---|
| No matching receiving stock | "No matching stock in receiving area." |
| Scanned qty > available | "Quantity exceeds available stock." |
| No picking order needs this item | "No linked picking order needs this item." |
| Scanned qty > remaining need | "Quantity exceeds what any picking order needs." |

## Out of Scope

- Real camera integration or OCR engine.
- Manual label entry from the scan modal.
- Scanning items already shelved (shelf-box logic is a future flow that may reuse the matching layer).
- Splitting a scanned quantity across multiple picking orders.

## Approaches Considered

1. **Simple modal flow (chosen)** — minimal UI, fast to implement, keeps user in context.
2. **Full-screen scanner UI** — more immersive, but heavier and overkill for a first demo.
3. **Bottom sheet flow** — mobile-native feel, but less suitable for desktop demo use.

## Visual Reference

Mockups were created in the visual companion session. See the session files under `.superpowers/brainstorm/` for the wireframes.
