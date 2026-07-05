# Label Scan / OCR-Assisted Picking

Some picking flows allow the operator to scan or type a supplier label. The system parses the label text and tries to match it to linked receiving and picking records.

## What the parser expects

Typical label fields:

- Part number
- Quantity
- Date / lot code
- Origin country

## How it works

1. The operator taps the scan button on the Picking tab of a receiving detail.
2. The `LabelScanReviewModal` opens.
3. The operator enters or confirms label data.
4. `useLabelScan` and `useScanMatchers` parse and normalize the input.
5. `db/ocrPicking.ts` matches the parsed data to receiving invoice items and picking items.
6. If a unique match is found, the pick is applied automatically.

## Known behavior

- The demo normalizes common OCR errors (for example, `O` → `0`).
- If the input does not match exactly one record, the operator must review or correct it.
- When the scanner detects more than one possible value for a field (for example, multiple date codes or countries of origin), the review modal shows the alternatives as a row of chips below the input. Tap a chip to switch the field to that value.
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
