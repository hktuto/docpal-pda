# Plan: admin flow-config editing

Spec: `docs/superpowers/specs/2026-08-12-admin-flow-config-design.md`

1. `apps/backend/src/config.ts`: add `getFlowConfig()` + `applyFlowConfig()`.
2. `apps/backend/src/routes/admin/flowConfig.ts`: GET/PUT route; mount in
   `apps/backend/src/routes/admin/index.ts` at `/flow-config`.
3. Route test `apps/backend/src/routes/admin-flow-config.test.ts` (pattern:
   `src/auth/auth.test.ts` — dynamic app import, login, app.request):
   GET shape, PUT persists + applies at runtime, PUT invalid → 400, PUT
   conflict rule → 400. Reset config module state after.
4. Admin UI: `apps/admin/utils/flowApi.ts` types + get/save;
   `apps/admin/pages/flow-config.vue` form; nav link in
   `apps/admin/utils/entities.ts` settings section; i18n keys
   `admin.navLinks.flowConfig` + `admin.pages.flowConfig.*` in
   `layers/i18n/i18n/locales/{en-US,zh-CN,zh-HK}.ts`.
5. Verify: backend suite, admin/web `nuxt prepare`, backend tsc.
6. Docs: AGENTS.md flow-config bullet (admin UI edit path),
   `docs/app-docs/ai/feature-registry.md` if it lists admin pages.
