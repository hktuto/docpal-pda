# Backend Scan Decode (POST /scan/decode)

Date: 2026-11-03
Status: implemented; PDA cutover done 2026-11-03 (same day, after the NCC
drawno requirement made server-side decode the only correct path); admin
supplier-editor preview still pending cutover

## Context

Label decode logic lives in three drifting copies: `apps/pda/utils/parseOcrScan.ts`
(client decode, 1000+ lines), `apps/backend/src/db/scanParse.ts` (server port),
`apps/admin/utils/qrTemplate.ts` (preview copy). Some suppliers' labels now
require **DB lookups to decode**, which the client-side path fundamentally
cannot do — the decode authority must be the backend. This app is already
online-only (no client cache, every commit needs :3002), so moving decode
server-side costs nothing in offline behaviour.

## Decisions

1. **New module `apps/backend/src/decode/`** (one folder = one owner, mirroring
   `src/auth/`, `src/export/`, `src/jobs/`):
   - `codecs.ts` — pure encoders/decoders. Mechanical move of the old
     `src/db/scanParse.ts` (no logic change; import sites updated).
   - `template.ts` — the supplier-template loop ported from the PDA's
     `parseQrCapture`: context-priority ordering (supplierCode → brand
     intersection → rest), per-template decode, order-targets gate. Reuses
     `codecs.ts parseQrRaw` for each template so the scan decode and the
     receiving commit path **cannot drift**.
   - `service.ts` — the only DB/config touchpoint: loads `supplier_profiles`
     templates (`listScanTemplates`), `date_code_counter_periods`
     (`listDateCodePeriods`) and flow-config `dateCodeFormat`, then calls the
     pure loop.
   - `index.ts` — public API (`decodeScan`, `decodeWithTemplates`, types).
2. **`POST /scan/decode`** (thin route `src/routes/decode.ts`, JWT-authenticated
   like every non-allowlisted route). Body:
   `{ raw, targets?, supplierCode?, brands? }` — the exact inputs
   `parseQrCapture` takes today (order context rides along so the targets gate
   keeps working). Response: the PDA `OcrParseResult` shape minus `raw`
   (`matched`, `parsed`, `options`, `supplier`) so the cutover is a
   mechanical swap. `matched:false` when no template hits.
3. **Standardization on `normalizePartNo`**: `parsed.itemId` and the targets
   comparison use the backend commit path's key (uppercase, whitespace-collapsed,
   `AMP(...)` unwrapped). Strictly a superset of the PDA's plain
   collapse/uppercase — same result for bare-PN labels, plus wrapped labels now
   match, exactly like the server already treats them at commit time. The
   targets gate matches `part_no` **OR** `wcl_item_no` (both normalized), the
   2026-11-03 scan-matching house rule (picking `1f28c493`,
   shelf-exchange `6f50054f`, shipping/verify/CN `a09d43da`).
4. **Not migrated (intentionally)**: `GET /scan-templates` and
   `GET /date-code-periods` stay as-is (they still feed the PDA's
   symbology-whitelist logic, which is device-side); the PDA decode path and
   the admin preview keep their local copies until the endpoint is field-tested
   and cut over in a follow-up. `parseAndIdentify`'s OCR-text heuristics stay
   client-side — they need no DB. (PDA cutover landed 2026-11-03; the admin
   preview copy remains.)
5. **Identity translation lives IN the decode (final, 2026-11-04):** some
   suppliers' labels do not carry the stored part identity, so `decodeScan`
   translates after the template match — guarded on the decoded profile's
   brands, so no other supplier's scan pays a query. An earlier
   `resolveMaster` request flag + `resolvedPart` response field was tried
   and deleted: the translation is the decode's job, not the caller's.
   - NCC: itemId is the numeric drawing code — `wcl_part_drawno` attaches the
     real `wcl_item_no`; itemId stays the drawing code.
   - TE: labels print a TRUNCATED MPN (e.g. `1571983-1` for stored
     `1-1571983-1`) — `resolveTeIdentity` (`db/partIdentity.ts`)
     resolves the real `part_no`/`wcl_item_no` from the parts master:
     normalized equality first (`idx_parts_norm_*`, migration 0051), then
     `ILIKE '%<scanned>%'` trigram fallback (`pg_trgm` GIN indexes,
     migration 0052). A unique hit REPLACES `parsed.itemId`/`wclItemNo` —
     every flow matches and displays the canonical identity through the
     normal parsed fields. Same-part dupes (one `part_no` under TE-/TE+ wcl
     keys, or an AMP-wrapped row beside a bare one) resolve to a STORED key,
     preferring the `AMP(...)` row (business tie from the 2026-11-04 field
     audit) — the fake `<brand>/<mpn>` derivation never survives.
     Genuinely different sibling parts resolve only when exactly one
     candidate is among the order `targets` (same rule as the NCC
     targets-rerun); otherwise the parsed label values stand. The receiving
     scan-commit (`db/receiving.ts`) retries its item match with the same
     candidates (`lookupPartKeyCandidates`) — the NCC drawno fallback's
     shape — so a truncated TE label received straight through the API
     works even without the client-side decode.
   - `GET /ad-hoc-put-away/part-lookup` (equality resolution) stays for the
     `manual-receiving` / `print-product-label` pages' own display flow.

## Files

- New: `src/decode/{index,service,template}.ts`, `src/decode/decode.test.ts`,
  `src/routes/decode.ts` (registered in `src/index.ts`).
- Moved: `src/db/scanParse.ts` → `src/decode/codecs.ts` (git mv; import paths
  updated in `src/db/*`, sync comments in PDA files and `docs/backend/*`).

## Verification

`pnpm --filter @warehouse/backend build` +
`pnpm --filter @warehouse/backend exec tsx --test src/decode/decode.test.ts`
(POST round-trip of the seeded KOA label, targets gate, 401/400 paths).
Test DB: `warehouse_backend_test` via `setupTestDb` (fake DocPal login,
`operator` demo user).
