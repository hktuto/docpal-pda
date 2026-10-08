# Ad-hoc put-away admin view — design

Date: 2026-10-08

Adds an admin console view for ad-hoc put-away batches, giving operators
and managers visibility into stock that was put away without a receiving
order. Read-only — no edit/delete actions.

## Goals

- List all ad-hoc put-away batches with filtering (supplier, shelf, date range).
- View batch detail: full item list with part, qty, date/lot code, COO/COW.
- Navigate from the admin sidebar.

## Architecture

### Data model

No new tables. Reads from the existing `ad_hoc_put_aways` table (created in
`0026_awesome_karnak.sql`). The `items` JSONB column holds the per-item
detail; the list query returns the batch-level columns only.

### Backend

**New route file `src/routes/admin/adHocPutAway.ts`** — thin route over a
new query function in `src/db/adhocPutaway.ts`.

#### `GET /admin/ad-hoc-put-aways`

Query params (all optional):

| Param | Type | Notes |
|-------|------|-------|
| `page` | integer | 1-based page number (default 1) |
| `pageSize` | integer | Rows per page (default 20, max 100) |
| `supplierCode` | string | Exact match on `supplier_code` |
| `shelfCode` | string | Exact match on `shelf_code` |
| `from` | date (YYYY-MM-DD) | `created_date >= from` |
| `to` | date (YYYY-MM-DD) | `created_date <= to` |

Response:
```json
{
  "rows": [
    {
      "id": "01J...",
      "supplierCode": "SUP001",
      "shelfCode": "A-01-01",
      "orgId": 2,
      "subInventoryCode": "MAIN",
      "totalQty": 15000,
      "itemCount": 3,
      "actorId": "user-uuid",
      "createdDate": "2026-10-08T10:30:00Z"
    }
  ],
  "total": 42
}
```

#### `GET /admin/ad-hoc-put-aways/:id`

Response:
```json
{
  "id": "01J...",
  "supplierCode": "SUP001",
  "shelfCode": "A-01-01",
  "orgId": 2,
  "subInventoryCode": "MAIN",
  "totalQty": 15000,
  "itemCount": 3,
  "actorId": "user-uuid",
  "createdDate": "2026-10-08T10:30:00Z",
  "items": [
    {
      "partNo": "ABC-123",
      "wclItemNo": "WCL-456",
      "qty": 5000,
      "dateCode": "2640",
      "lotCode": "LOT-A",
      "coo": "CN",
      "cow": "CN",
      "serialNo": null
    }
  ]
}
```

#### Route registration

Add to `src/routes/admin/index.ts`:
```typescript
import { adHocPutAwayRoute } from "./adHocPutAway.js";
adminRoute.route("/ad-hoc-put-aways", adHocPutAwayRoute);
```

### Admin frontend

**New page `apps/admin/pages/ad-hoc-put-aways/index.vue`** — list view.

Columns:
- ID (first 8 chars, links to detail)
- Supplier Code
- Shelf Code
- Org / Sub-Inventory
- Item Count
- Total Qty
- Created Date
- Actor (user id, first 8 chars)

Filters (above the table):
- Supplier Code — `SearchableSelect` (single) populated from `GET /admin/suppliers`
- Shelf Code — `SearchableSelect` (single) populated from `GET /admin/shelves`
- Date range — two `<input type="date">` for from/to

Pagination: reuse `Pager` + `useAdminTable` pattern from shelf-boxes.

**New page `apps/admin/pages/ad-hoc-put-aways/[id].vue`** — detail view.

Layout:
- Header: batch ID, supplier, shelf, org/sub-inv, total qty, item count, created date, actor
- Items table: Part No, WCL Item No, Qty, Date Code, Lot Code, COO, COW, Serial No
- Back to list button

**Navigation**: Add to `apps/admin/TOC.md` and the sidebar nav component:
```
Ad-Hoc Put-Aways → /ad-hoc-put-aways
```

### i18n

New keys under `admin.pages.adHocPutAways.*`:
- `title`, `supplier`, `shelf`, `org`, `subInventory`, `itemCount`, `totalQty`, `created`, `actor`
- `filterSupplier`, `filterShelf`, `filterFrom`, `filterTo`
- `detailTitle`, `backToList`, `items`
- `noItems`, `noResults`

### Types

Inline in the page (matching the shelf-boxes pattern — no shared entity file):
```typescript
interface AdHocPutAwayListRow {
  id: string;
  supplierCode: string;
  shelfCode: string;
  orgId: number;
  subInventoryCode: string;
  totalQty: number;
  itemCount: number;
  actorId: string;
  createdDate: string;
}

interface AdHocPutAwayDetail extends AdHocPutAwayListRow {
  items: Array<{
    partNo: string;
    wclItemNo: string | null;
    qty: number;
    dateCode: string | null;
    lotCode: string | null;
    coo: string | null;
    cow: string | null;
    serialNo: string | null;
  }>;
}
```

## Out of scope

- Edit/delete ad-hoc put-away batches (audit trail is immutable).
- Export to CSV/PDF.
- Approval workflow.
- Real-time updates (SSE) — admin refreshes manually.
- Filtering by actor or item count range.

## Tests

- Backend: no new tests needed (read-only queries; existing adhocPutaway.test.ts
  covers the write path).
- Admin frontend: no unit tests (same as other admin pages — page-level only).

## Files

- `apps/backend/src/db/adhocPutaway.ts` — add `listAdHocPutAways` + `getAdHocPutAwayDetail`
- `apps/backend/src/routes/admin/adHocPutAway.ts` — new route file
- `apps/backend/src/routes/admin/index.ts` — register route
- `apps/admin/pages/ad-hoc-put-aways/index.vue` — list page
- `apps/admin/pages/ad-hoc-put-aways/[id].vue` — detail page
- `apps/admin/TOC.md` — nav entry
- `apps/admin/components/Sidebar.vue` (or nav component) — add link
- `layers/i18n/i18n/locales/{en-US,zh-CN,zh-HK}.ts` — new strings
- `docs/backend/api-design.md` — document new endpoints
- `docs/app-docs/ai/code-map.md` — file mapping
- `docs/app-docs/ai/feature-registry.md` — feature entry
