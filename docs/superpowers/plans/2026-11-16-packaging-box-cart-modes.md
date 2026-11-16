# Packaging box/cart modes — implementation plan

Spec: `docs/superpowers/specs/2026-11-16-packaging-box-cart-modes-design.md`

1. Backend schema: add `packed_input_box_count` + `packed_carts` to `picking_orders`
   (`src/db/schema/picking.ts`), `pnpm --filter @warehouse/backend db:generate` → 0066.
2. Backend domain: `confirmPackaging` typed input (box mode / cart mode / derived totals),
   row+detail SELECT the two new fields; route normalizes legacy payloads; clear the new
   columns in the admin order reset; extend the shipping box-detail order rows.
3. Backend tests: `packaging.test.ts` new confirm matrix (box/cart/legacy/validation).
4. PDA: types + adapter payload, `pages/packaging/[orderId].vue` two-mode form + read-back,
   i18n keys, adapter vitest updates.
5. Admin: `flowApi.ts` types + `pages/packaging/[id].vue` twin form + read-back,
   `pages/shipping/[id].vue` per-cart copy-summary lines, i18n keys.
6. Verify: backend build + tests, PDA vitest + `nuxt prepare`, then commit.
7. Docs: api-design.md, schema-tables.md, app-docs packaging flow files + registry/code-map,
   dev-guide-zh packaging.md, functions.json wording + regenerate the UAT xlsx.
