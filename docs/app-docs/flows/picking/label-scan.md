# Label Scan / OCR-Assisted Picking

Some picking flows allow the operator to scan or type a supplier label. The system parses the label text and tries to match it to linked receiving and picking records.

## What the parser expects

Typical label fields:

- Part number
- Quantity
- Date / lot code
- Origin country

## How it works

1. The operator taps the scan button (receiving detail, picking detail,
   put-away detail, or measuring box page).
2. The label is captured (camera on Android, or a typed/pasted value).
3. `useLabelScan` + `utils/parseOcrScan.ts` parse and normalize the input
   against the supplier's QR template (fetched from `GET /scan-templates`).
4. What happens next depends on the flow:
   - **Receiving** — the raw label is sent to
     `POST /receiving-orders/:id/scan`; the server parses and matches it.
     On a 409 (`no_match` / `multiple_matches`) the
     `ReceivingScanReviewModal` shows the candidates and the operator picks
     one.
   - **Picking / put-away / measuring** — `useScanMatchers` validates the
     parsed label client-side against the pre-selected allocation, the
     pinned receiving item, or the box's packages; a single match applies
     the action (pick / stage / verify) through `WarehouseService`.

## Known behavior

- The demo normalizes common OCR errors (for example, `O` → `0`).
- If the input does not match exactly one record, the operator must review or correct it.
- When the scanner detects more than one possible value for a field (for example, multiple date codes), the review modal shows the alternatives as a row of chips below the input. Tap a chip to switch the field to that value. Part number and COO/COW are dropdowns instead of free text: part number lists the parent document's possible scan targets (the order's lines / the box's packages), COO/COW list the `country_list` master with localized display names and start empty; values scanned outside those lists stay selectable as-is.
- Edits made in the review form always take effect on **Apply** — the app re-matches the edited values before writing, so there is no need to tap **Find Match** first. On the backend, a supplied batch value overwrites the one stamped on the receiving invoice item (an empty field keeps the current value).
- Empty `dateCode`, `lotCode`, `coo`, or `cow` values on a receiving invoice item or on an already-created package are treated as wildcards. The matcher only checks fields that actually contain a value, so a label that supplies extra codes still matches as long as the populated fields agree.

## Browser testing

When running the app in a browser, tapping Scan opens a `prompt()` instead of the camera. Paste a JSON string with `text` (OCR text) and `barcodes` (array of `{ value, format }`) to simulate a captured label:

```json
{
  "text": "PART: RK73B1JTTD181G\\nQTY: 5000",
  "barcodes": [{ "value": "RK73B1JTTD181G", "format": "CODE_128" }]
}
```

The app then runs the same parse, match, and review pipeline used on Android.
