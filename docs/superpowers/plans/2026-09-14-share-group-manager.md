# Share-group manager — implementation plan

Date: 2026-09-14
Spec: `docs/superpowers/specs/2026-09-14-share-group-manager-design.md`

1. `apps/admin/pages/sub-inventories.vue`
   - Replace the `#cell-shareGroup` free-text input + save button with a
     `<select>` (empty option = none + existing group names from
     `shareGroups`); `onChange` → `PUT /admin/sub-inventory-share-groups/:id`.
     Drop `shareDrafts` / `shareDirty`.
   - Add a "Share groups" head-action button and a management dialog:
     group list (from `shareGroups`), new-group input, rename field,
     org-grouped member checkbox picker keyed on `orgId:code`
     (pattern: `apps/admin/components/SubInventoryScopePicker.vue`, pair-keyed;
     feed it the page's `rows` instead of fetching), other-group badges,
     save = per-member PUT diff + `load()`. New state: `showShareMgr`,
     `shareMgrError`, `selectedGroup`, `groupNameDraft`, `memberDraft`,
     `groupsList` computed; `useOverlayDismiss` for the dialog.
2. i18n: `admin.pages.subInventories.shareManager.*` in
   `layers/i18n/i18n/locales/{en-US,zh-CN,zh-HK}.ts`.
3. Docs: `docs/app-docs/ai/feature-registry.md` (share-groups row),
   `docs/app-docs/ai/code-map.md` (sub-inventories row).
4. Verify: `pnpm --filter @warehouse/admin nuxt prepare`; manual browser check
   with `pnpm dev:backend` + `pnpm dev:admin` (create/move/rename/delete group,
   dropdown assign/clear).
