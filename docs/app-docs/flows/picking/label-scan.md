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
