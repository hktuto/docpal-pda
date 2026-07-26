# Supplier QR-template editor (admin) — design

## Goal

Let a non-technical admin user create and edit a supplier's QR/barcode scan template in the admin console, without writing or understanding regular expressions. Today `supplier_profiles.qr_template` is a raw JS regex with named capture groups edited through a plain text input — unusable for the target user, and a broken regex saves silently and just stops matching on the PDA.

## Context

- `supplier_profiles` (`apps/backend/src/db/schema/master.ts:49-60`) holds `qr_template` (regex with named groups), `qr_type` (barcode symbology metadata, currently write-only), `qty_encoding` (only `koa_zeros` has behavior), `name`, `remark`.
- The runtime source of truth is the regex string. Both parsers compile it as-is:
  - web: `getQrTemplateRegex` / `parseQrCapture` in `apps/web/utils/parseOcrScan.ts:627-720`
  - backend: `parseQrRaw` in `apps/backend/src/db/scanParse.ts:39-96`
- Recognized named groups: `itemId` (required), `qty`, `lotCode`, `dateCode`, `coo`, `cow`, `serialNo`. Unknown group names are ignored.
- `GET /scan-templates` returns `{ supplierCode, qrTemplate, qtyEncoding }` and is unchanged by this feature.
- `qr_type` records which barcode symbology the supplier's labels use (QR Code, PDF417, Code 128, …) so the PDA knows what to expect. It is orthogonal to `qr_template` (which parses the decoded string). Nothing reads it yet; the scan flow already distinguishes QR-only captures by ML Kit format (`apps/web/composables/useLabelScan.ts:47`), so a future change may use it — the editor should surface it properly, not drop it.
- Admin edits profiles via `pages/suppliers.vue` "Edit profile" row action → generic `CrudForm` (text inputs only) with a client-side upsert (`PATCH` if a profile exists for the supplier code, else `POST`).
- Real supplier labels are overwhelmingly delimiter-separated fields. Example (KOA, PDF417 payload): `:RK73H1JTTD1002F:S1:14:X:L2601A:602:KOA+RK73H1JTTD1002F` → part / subId / qty / ignore / lot / serial / full name.

## Design

The editor is a **regex generator with a test bench**. Storage stays a regex string; the PDA parser, `/scan-templates`, and all scan flows are untouched. The structured definition the user edits is stored alongside in a new JSON column so the editor can re-open a template in structured mode.

### New column

`supplier_profiles.qr_template_config` — nullable `jsonb`. Shape:

```json
{
  "version": 1,
  "mode": "delimited",
  "delimiter": ":",
  "fields": [
    { "role": "ignore" },
    { "role": "itemId" },
    { "role": "ignore" },
    { "role": "qty" },
    { "role": "ignore" },
    { "role": "lotCode" },
    { "role": "serialNo" },
    { "role": "ignore" }
  ]
}
```

- `mode`: `"delimited" | "fixed" | "advanced"`.
- `delimited`: `delimiter` (single character) + `fields` in label order. Field roles: `itemId | qty | lotCode | dateCode | coo | cow | serialNo | ignore`. Exactly one `itemId`.
- `fixed`: `fields` carry `start`/`length` (character positions on the sample); gaps between fields are implicit skips.
- `advanced`: config is just `{ "version": 1, "mode": "advanced" }`; the regex in `qr_template` is edited directly (power users, legacy hand-written templates).
- The regex remains the runtime artifact. The editor always writes **both** `qrTemplate` (derived) and `qrTemplateConfig` (source) in the same save. A profile with a regex but no config opens in advanced mode with a "Rebuild from a sample scan" affordance that switches into delimited mode.

### `buildRegex(config) → string`

Pure function in `apps/admin/utils/qrTemplate.ts`. Rules for `delimited` mode:

- Regex-escape the delimiter (`|` → `\|`, `:` → `:` etc.).
- Each field becomes one segment:
  - `ignore` → `[^<delim>]*` (no capture group)
  - any other role → `(?<role>[^<delim>]*)`
- Join segments with the escaped delimiter, anchor `^…$`.

Example: the KOA config above generates
`^[^:]*:(?<itemId>[^:]*):[^:]*:(?<qty>[^:]*):[^:]*:(?<lotCode>[^:]*):(?<serialNo>[^:]*):[^:]*$`
— matching-equivalent to the hand-written seed regex.

`fixed` mode: each field → `(?<role>.{length})`, gaps → `.{n}`, anchored. `advanced` mode: `qrTemplate` is user-supplied, `buildRegex` is not used.

### Editor UX (admin, suppliers page)

The "Edit profile" row action opens a hand-rolled dialog (pattern: `pages/sub-inventories.vue` — overlay + `.dialog` + `.form-row`, `useOverlayDismiss`), replacing the current `CrudForm` profile edit. Sections:

1. **Profile basics** — Name (text), Remark (text).
2. **Label code type** (`qr_type`) — dropdown with plain names: `QR Code`, `PDF417`, `Code 128`, `EAN-13 / ISBN`, `Data Matrix`, `Other…` (free text). Help text: "The kind of barcode printed on this supplier's labels." Informational today.
3. **Quantity format** (`qty_encoding`) — dropdown: `Plain number` (null) / `KOA style — last digit counts zeros (e.g. 253 → 25,000)` (`koa_zeros`).
4. **Scan template** — the builder:
   - *Sample scan* box: user scans/pastes a real label payload.
   - *Format* radios: `Separated by a character` (delimiter picker: `:` `;` `,` `|` `Tab` `Other`) / `Fixed positions` / `Advanced (edit pattern directly)`.
   - *Field labeling*: the sample split into segments shown as chips in order; each chip has a dropdown: `Part number (required)`, `Quantity`, `Lot code`, `Date code`, `Country of origin`, `Serial number`, `Ignore this piece`. Empty segments default to `Ignore`.
   - *Live preview*: parsed result of the sample as a small table (`Part: RK73H1JTTD1002F · Qty: 10,000 (KOA format) · Lot: L2601A`), plus the generated pattern in grey mono text (informational only).
   - *Test more scans*: a multi-line box for additional real labels; each line gets a green tick (parsed values shown) or red cross with a plain-language reason ("this scan has 6 pieces but the template expects 7"). Red rows block saving.
   - Validation before save: exactly one `Part number` field; sample parses; all test scans parse; advanced mode regex compiles (`new RegExp` in the browser — same engine as the parser).
5. **Save** — existing upsert logic: `PATCH /admin/supplier-profiles/:id` if a profile exists for the supplier code, else `POST`. Payload: `supplierCode`, `name`, `qrType`, `qtyEncoding`, `remark`, `qrTemplate` (derived), `qrTemplateConfig`.

Fixed-positions mode UI: the sample is shown as a monospace ruler; the user clicks-drag to mark a field's start/end and picks its role. (Keep the interaction minimal — click to add field boundaries is acceptable for v1; exotic layouts can use Advanced.)

### Backend changes

- `apps/backend/src/db/schema/master.ts`: add `qrTemplateConfig: jsonb("qr_template_config")` to `supplierProfiles`. `pnpm --filter @warehouse/backend db:generate` for the migration.
- `apps/backend/src/routes/admin/index.ts` supplier-profiles router: accept optional `qrTemplateConfig` (JSON value, null to clear). No regex validation server-side (editor validates client-side; the generic CRUD stays generic).
- Seed: add the matching `qrTemplateConfig` to the two KOA profiles in `apps/backend/src/db/seed.ts:110-124` so the demo opens in structured mode.

### Explicitly out of scope

- No regex builder beyond delimited + fixed-width; anything else → Advanced mode.
- No server-side template validation endpoint (client-side compile + sample tests cover it; the browser runs the same JS regex engine as the PDA).
- No change to `qr_type` semantics or `/scan-templates` (a future change may expose `qr_type` to the PDA).
- No i18n of page content (admin pages are English-only today; nav unchanged since no new nav entry is added).

## Testing

- `apps/admin/utils/qrTemplate.ts` unit tests if a vitest setup exists for admin; otherwise mirror the generator tests through the backend parser: a backend test that takes the editor-generated regex for the KOA config and asserts `parseQrRaw` returns the same fields as the hand-written seed regex (guards generator/parser drift).
- Backend test: PATCH `/admin/supplier-profiles/:id` accepts and round-trips `qrTemplateConfig`.
- Manual: log into admin, edit KOA's profile in structured mode, add a breaking test scan, confirm save is blocked; save and confirm the PDA receiving scan still parses (via `pnpm --filter @warehouse/backend test` receiving tests against the seeded regex).

## Docs

Update `docs/backend/schema-tables.md` (new column) and `docs/app-docs/flows/picking/label-scan.md` / `docs/app-docs/ai/feature-registry.md` if they reference template editing.
