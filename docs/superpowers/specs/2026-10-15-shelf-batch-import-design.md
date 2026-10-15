# Shelf Batch Import — Design Spec

**Date:** 2026-10-15
**Status:** Approved

## Summary

Add a `POST /admin/shelves/batch-import` endpoint that accepts an array of shelf objects and creates/updates them in a single API call. The admin shelf list page's Import Excel function uses this endpoint instead of making one POST/PATCH per row.

## Backend

### Endpoint

`POST /admin/shelves/batch-import`

**Request body:**
```json
{
  "shelves": [
    { "code": "SZD01", "displayName": "SZ-D01", "zone": null, "warning": null, "subInventoryScopes": [{ "orgId": 7, "code": "SZSZ1" }] },
    ...
  ]
}
```

**Response:**
```json
{
  "created": 10,
  "updated": 5,
  "skipped": 2,
  "errors": [{ "code": "SZD01", "message": "duplicate" }]
}
```

### Logic

1. Fetch all existing shelf codes into a `Set`.
2. For each shelf in the request array:
   - Validate `code` is a non-empty string (skip + collect error if invalid).
   - If code exists in the set → build an UPDATE (displayName, zone, warning, subInventoryScopes — only include fields present in the input).
   - If code doesn't exist → build an INSERT (same fields + code).
3. Execute all inserts and updates in a single transaction.
4. Return counts + any per-row errors.

### Validation

- `code`: required, non-empty string (same as single create).
- `displayName`, `zone`, `warning`: optional string or null.
- `subInventoryScopes`: optional array of `{ orgId: number, code: string }` or null.
- Rows with invalid data are skipped and reported in `errors`; valid rows still succeed.

### Error handling

- 400 if `shelves` is missing or not an array.
- 400 if `shelves` is empty.
- Per-row errors (e.g. invalid sub-inventory reference) are collected and returned in `errors` — the overall request still succeeds for valid rows.

## Frontend

### `apps/admin/pages/shelves.vue`

Replace the per-row loop in `onImportFile` with a single `api.post("/admin/shelves/batch-import", { shelves: [...] })` call. Parse the Excel into the same body array, send it all at once, and display the response counts.

### Import body construction

For each Excel row, build:
```ts
{
  code: string,
  displayName?: string | null,
  zone?: string | null,
  warning?: string | null,
  subInventoryScopes?: { orgId: number; code: string }[] | null
}
```

Only include fields that have a corresponding column in the Excel file (skip undefined column indices).

## File changes

| File | Change |
|------|--------|
| `apps/backend/src/routes/admin/shelfBatchImport.ts` | New file — batch import route |
| `apps/backend/src/routes/admin/index.ts` | Register the batch import route |
| `apps/admin/pages/shelves.vue` | Replace per-row API loop with single batch call |
