# Supplier QR-template editor (admin) — implementation plan

Spec: `docs/superpowers/specs/2026-07-24-supplier-qr-template-editor-design.md`

1. **Schema** `apps/backend/src/db/schema/master.ts`: add to `supplierProfiles`
   - `qrTemplateConfig: jsonb("qr_template_config")` (nullable).
   Run `pnpm --filter @warehouse/backend db:generate`. No backfill needed
   (null config → advanced mode in the editor).
2. **Admin API passthrough** `apps/backend/src/routes/admin/index.ts`
   (supplier-profiles router, lines ~66-90): add an optional `qrTemplateConfig`
   field. Check `crud.ts` validators — if there is no JSON validator, accept it
   as an arbitrary JSON value (object or null; reject non-object non-null with
   400). Include it in create + update column maps.
3. **Seed** `apps/backend/src/db/seed.ts:110-124`: add `qrTemplateConfig`
   (delimited `:` config per the spec example) to the `KOA` and `KOA+TCG`
   profiles. Regex values unchanged.
4. **Generator util** `apps/admin/utils/qrTemplate.ts`:
   - Types: `QrTemplateConfig`, `FieldRole` (`itemId | qty | lotCode |
     dateCode | coo | cow | serialNo | ignore`), mode union.
   - `buildRegex(config): string` per spec rules (escape delimiter,
     `[^d]*` segments, named groups for non-ignore roles, `^…$`; fixed mode
     `.{n}` gaps + `(?<role>.{length})`).
   - `parseWithRegex(regex, sample): Record<string,string> | null` — thin
     wrapper: compile with `"u"` flag, return named groups or null
     (mirrors `parseOcrScan.ts` semantics, tolerate invalid regex → null).
   - `decodeKoaQty(qty: string): number | undefined` — copy of the small
     helper (`parseOcrScan.ts:616-625`) for the preview's decoded qty.
   - `detectMode(profile) → QrTemplateConfig` — return stored
     `qrTemplateConfig` if present, else `{ version: 1, mode: "advanced" }`.
5. **Editor dialog** `apps/admin/components/QrTemplateEditorDialog.vue`
   (hand-rolled, pattern from `pages/sub-inventories.vue`): props
   `supplier` (code/name) + `profile` (existing row or null); emits `saved`.
   - Basics: Name, Remark (text inputs), Label code type (select: QR Code /
     PDF417 / Code 128 / EAN-13 / ISBN / Data Matrix / Other→free text),
     Quantity format (select: Plain / KOA style).
   - Sample scan textarea; format radios (delimited / fixed / advanced).
   - Delimited: delimiter select (`:` `;` `,` `|` `Tab` `Other`); split
     sample into chips, per-chip role `<select>` (Part number / Quantity /
     Lot code / Date code / Country of origin / Serial number / Ignore),
     empty chip → Ignore; enforce exactly one Part number (disable save +
     inline hint otherwise).
   - Fixed: monospace sample with click-to-mark field boundaries; per-field
     role select. (Minimal interaction; keep code small.)
   - Advanced: textarea bound to `qrTemplate`, "Rebuild from a sample scan"
     button switching to delimited mode.
   - Live preview card: parsed fields table from the sample (qty decoded
     when KOA format selected); generated regex in grey `<code>`.
   - Test scans: textarea, one scan per line; per-line green/red with parsed
     values or a plain reason (segment-count mismatch, no part number).
     Any red line or invalid sample → Save disabled with inline message.
   - Save: `PATCH /admin/supplier-profiles/:id` when `profile` exists else
     `POST`; body `{ supplierCode, name, qrType, qtyEncoding, remark,
     qrTemplate, qrTemplateConfig }` (advanced: config `{version:1,mode:
     "advanced"}` + raw `qrTemplate`). Errors shown via `e.message` in
     `.error-banner`.
6. **Wire into suppliers page** `apps/admin/pages/suppliers.vue`: replace the
   profile `CrudForm` + its `entities["supplier-profiles"]` usage with
   `QrTemplateEditorDialog`; keep the profiles list fetch + upsert
   decision. Remove the now-unused `"supplier-profiles"` entry from
   `utils/entities.ts` only if nothing else references it (grep first).
7. **Tests**:
   - `apps/backend/src/db/scanParse.test.ts` (or `receiving.test.ts`): the
     editor-generated KOA regex (from the seeded `qrTemplateConfig` via the
     same build rules — duplicate the tiny build inline in the test or export
     a shared helper if a sensible shared location exists) parses the known
     KOA sample to part `RK73H1JTTD1002F`, qty 10000, lot `L2601A`,
     serial `602` via `parseQrRaw`.
   - Backend CRUD test (extend the admin routes test file if one exists,
     else add a small one): PATCH round-trips `qrTemplateConfig`; non-object
     value → 400.
   - Run `pnpm --filter @warehouse/backend test` and
     `pnpm --filter @warehouse/backend build`.
8. **Docs**: `docs/backend/schema-tables.md` supplier_profiles section — add
   `qr_template_config`; check `docs/app-docs/ai/feature-registry.md` +
   `docs/app-docs/flows/picking/label-scan.md` for template-editing mentions
   and update. Update root `AGENTS.md` supplier_profiles sentence to mention
   the new column.
9. **Manual verify**: `pnpm dev:backend` + `pnpm dev:admin`; log in as
   `admin` / `DocPalAdmin2026!`; Suppliers → KOA → Edit profile opens in
   structured mode with the seeded config; paste the KOA sample + one broken
   scan; confirm save blocked, fix, save; `GET /scan-templates` still returns
   the regex; `pnpm --filter @warehouse/backend test` green.
