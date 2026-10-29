# Label source + label-aware verify — implementation plan

Spec: `docs/superpowers/specs/2026-10-30-label-source-and-label-verify-design.md`

## Task 1 — backend schema + migration

Files: `apps/backend/src/db/schema/label-print.ts`, `schema/picking.ts`, new `schema/label-prints.ts`, `db:generate`.

- `label_print_rules.label_source` text NOT NULL DEFAULT 'internal' (+ CHECK).
- New `label_prints` table per spec Part 2 (id, picking_order_id FK, rule_id,
  label_type, print_template_id, printer_name/service_id/device_key,
  expected_label_count int, payload jsonb, result jsonb NULL, printed_by,
  created/last_update dates).
- `picking_packages.label_verified` bool NOT NULL DEFAULT false,
  `label_verified_at` timestamptz NULL, `label_verified_by` text NULL.
- `shipping_boxes.carton_label_verified` bool NOT NULL DEFAULT false,
  `carton_label_verified_at` timestamptz NULL, `carton_label_verified_by` text NULL.

## Task 2 — label source plumbing

Files: `src/db/labelPrint.ts`, `src/db/labelPrintParams.ts`, `src/routes/picking.ts`,
`apps/admin/utils/entities.ts`, `apps/admin/pages/label-print-rules/[id].vue`.

- Matches carry `labelSource`; `POST /picking-orders/:id/label-print` → 409
  `label_rule_external` for external rules.
- Admin rule form: labelSource select (internal default).

## Task 3 — print records

Files: `src/db/labelPrintParams.ts`.

- Converter row shape gains `{packageId?, shippingBoxId?}` linkage (default
  builders + yhft-ch-01 wrap their existing params rows).
- `printOrderLabel` inserts one `label_prints` row after successful upstream
  print with `expectedLabelCount` = row count and full payload.

## Task 4 — verify backend

Files: `src/db/verify.ts`, `src/db/picking.ts` (verifyPackage,
completeVerifyTask→verify.ts, reopenShippingBox), `src/routes/verify.ts`.

- `GET /verify-tasks/lookup-by-label?raw=` — match raw vs carton print rows
  (any string param field equality) → `{taskId, shippingBoxId}`; stamps
  carton_label_verified. 404 `label_print_not_found`.
- `POST /verify-tasks/:id/scan-label {raw}` — item/item_box label match for the
  task's box's orders; marks `picking_packages.label_verified`; returns
  `{kind, packageId, expectations:{partNo,wclItemNo,coo,dateCode,qty}}`.
- `verifyPackage` — when package is label_verified, hard-compare scanned
  part/coo/dateCode vs label record → 409 `label_item_mismatch {fields}`.
- `completeVerifyTask` — 409 `labels_not_all_verified` gate.
- `reopenShippingBox` — reset label/carton flags.
- `GET /verify-tasks/:id` + `GET /measuring-boxes/:id` — packages carry
  `labelMode`, `labelVerified`; box carries `cartonLabelRequired/Verified`.

## Task 5 — PDA

Files: `components/picking/LabelPrintRulesPanel.vue`, `components/MeasureBox.vue`,
`pages/verify/index.vue`, adapter + i18n (3 locales).

- External info rows (no button, excluded from printAll/allPrinted).
- Verify list scan: carton-label lookup before box-id match.
- MeasureBox: two sections (per-item totals for aggregate packages; per-package
  label rows for label mode), scan dispatch label-first.

## Task 6 — tests + docs

- Backend node:test (spec §Testing), PDA vitest for grouping/dispatch.
- Update AGENTS.md (label source, label_prints, verify rework) and
  docs/app-docs flows for labeling + verify.
