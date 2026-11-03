# Backend Scan Decode — full implementation plan & status

Spec: `docs/superpowers/specs/2026-11-03-backend-scan-decode-design.md`
Date: 2026-11-03

Legend: ✅ done & verified · 🟡 done, uncommitted (this session) · 🧪 awaiting field test · ⏳ pending

## Goal

Make the backend the single decode authority for supplier label QR values (some
labels need DB lookups the PDA cannot do), ending the 3-copy drift
(`apps/pda/utils/parseOcrScan.ts`, backend `scanParse.ts`,
`apps/admin/utils/qrTemplate.ts`). Cutover of PDA/admin happens only after the
endpoint is field-tested.

## Status snapshot

- On HEAD: `src/decode/codecs.ts` exists (interim commits `9f5041d5`/`b0836225`
  kept HEAD building during the `db/scanParse.ts → decode/codecs.ts` move;
  `bb1b44bb` swept part of the rename). Some import-sweeps already landed via
  those commits (e.g. `shelfExchange.ts`).
- Committed as its own decode-set commit (Phase 5 ✅); endpoint deployed
  alongside the app but not called by any client yet — field test (🧪) gates
  the Phase 6 cutover.
- Verified: `pnpm --filter @warehouse/backend build` clean;
  `src/decode/decode.test.ts` 6/6; decode+labels+receiving 47/47; full suite
  A/B against clean HEAD = identical 11 failures (labeling ×6, picking
  outdated-warnings ×2, work-lock ×1, admin docpal-url ×2) — all pre-existing,
  none from this work.

## Phase 1 — decode module ✅🟡

| Step | Status | Notes |
|---|---|---|
| 1.1 `git mv db/scanParse.ts → decode/codecs.ts` | 🟡 | mechanical; deletion of the stopgap `db/scanParse.ts` copy + remaining importer sweep still uncommitted |
| 1.2 `decode/template.ts` | ✅🟡 | `parseQrCapture` loop port: supplierCode → brand-intersection → rest priority, order-targets gate; per-template decode reuses `parseQrRaw`, so scan-decode ≡ receiving-commit decode (no drift possible). `parsed.itemId` standardized on `normalizePartNo` (superset of old PDA compare, documented in spec) |
| 1.3 `decode/service.ts` | ✅🟡 | `decodeScan(db, {raw, targets?, supplierCode?, brands?})`; reads `supplier_profiles` + `date_code_counter_periods` + flow-config `dateCodeFormat` |
| 1.4 `decode/index.ts` | ✅🟡 | public surface: `decodeScan`, `decodeWithTemplates`, `DecodedScan`/`ScanDecodeInput` |

## Phase 2 — endpoint ✅🟡

| Step | Status | Notes |
|---|---|---|
| 2.1 `POST /scan/decode` (`routes/decode.ts`, mounted in `src/index.ts`) | ✅🟡 | JWT by global middleware; `400 invalid_payload: …` on bad body; response = PDA `OcrParseResult` shape **minus `raw`** (never echoed); `matched:false` when no template hits |
| 2.2 `decode/decode.test.ts` | ✅ | KOA round-trip incl. month-counter via DB periods, matched-false, targets gate (case/space-insensitive), 401 / 400 / 200 |

## Phase 3 — docs ✅🟡

Spec + this plan + `docs/backend/api-design.md` scan-support row +
`README`/`schema-conventions`/PDA sync-comment path updates.

## Phase 4 — field test 🧪 (user, next)

```bash
pnpm dev:backend
TOKEN=$(curl -s localhost:3002/auth/login -d '{"username":"<user>","password":"***"}' | jq -r .token)
curl -s localhost:3002/scan/decode -H "Authorization: Bearer $TOKEN" -d '{"raw":"<real label QR>"}' | jq
```

Test matrix: (a) KOA demo raw round-trip, (b) the new DB-lookup supplier label
that motivated this, (c) label not in the order → pass `targets`, expect
`matched:false`, (d) real PDA Wi-Fi latency sanity (`[SCAN-TIME]` logs).

## Phase 5 — commit ✅

The unrelated parallel changes (auth, migration `0048`, schema master, CN flows,
TE matching fixes) landed separately in the team's commits the same day. The
decode set ships as its own commit: `src/decode/*` (module + tests, deletion of
the `db/scanParse.ts` stopgap, import-site sweep, `src/index.ts` mount),
`src/routes/decode.ts`, PDA comment-path files,
`docs/backend/{README,api-design,schema-conventions}.md`, AGENTS.md, spec + plan.
(`docs/superpowers/audits/` and `task-list-*.xlsx` are foreign — left untracked.)

## Phase 6 — PDA cutover ⏳ (after Phase 4 passes)

1. `WarehouseService`/`backendWarehouse`/`services/types`: add `decodeScan(raw, ctx)`; response maps 1:1 to `OcrParseResult` (rebuild `raw` locally).
2. `useLabelScan.processCapture` + `parseRawValue`: QR branch → `await decodeScan(...)`; on `matched:false` run local `parseAndIdentify` fallback (identical to today's fallthrough). Keep `[SCAN-TIME]` logging; one POST per scan.
3. Delete the duplicated decoders from `parseOcrScan.ts` (`parseQrCapture`, codecs, `DEFAULT_KOA_PERIODS`, `DateCodePeriod`) — keep the no-DB OCR heuristics; port/remove their vitest mirror cases (backend already covers them). Drop `getCachedDateCodePeriods`.
4. `pnpm --filter @warehouse/pda test` + `nuxt prepare` + manual scan flows (receiving / put-away / measuring).

## Phase 7 — admin cutover ⏳

- `SupplierProfileEditor.vue` preview → same endpoint. **Open decision:** the
  editor previews *unsaved* draft templates, but `/scan/decode` reads the DB —
  either keep the small client preview copy, or add an admin-only body override
  `{template, qtyEncoding, dateCodeEncoding}` (trusted, internal). Decide here,
  not earlier.

## Phase 8 — shrink / cleanup ⏳

- `GET /scan-templates`: after Phase 6 its only remaining client need is
  `barcodeTypes` (symbology whitelist) — narrow the payload or keep;
  `GET /date-code-periods`: delete with the last consumer.
- Update `AGENTS.md` + `docs/app-docs/ai/*` (+ flow `ai-scope.md`) when the PDA
  actually decodes remotely — 3 copies → 1 is the end state.

## Known deltas / risks

- `parsed.itemId` is `normalizePartNo`'d (AMP-unwrapped) — deliberately the
  commit path's key; wrapped-label matches that the PDA copy skipped will now
  match server-side.
- Decode latency = one LAN round-trip per scan (app is already online-only;
  verify on-device in Phase 4d).
- The `targets` gate compares `part_no` OR `wcl_item_no` (normalized) — the
  2026-11-03 house rule, matching the picking/shelf-exchange fixes; it is
  strictly more forgiving than the still-live PDA `parseQrCapture` gate
  (part only), which the Phase 6 cutover replaces.
