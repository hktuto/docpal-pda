# Feature Registry

Machine-readable index of features in the warehouse PDA demo. Use this page to locate implementation files and scope notes.

| Feature | Flow | Status | Key Files | Scope Doc |
|---------|------|--------|-----------|-----------|
| Picking list | Picking | Shipped | `pages/picking/index.vue` | [ai-scope](../flows/picking/ai-scope.md) |
| Picking detail | Picking | Shipped | `pages/picking/[id].vue` or equivalent | [ai-scope](../flows/picking/ai-scope.md) |
| OCR-assisted picking | Picking / Receiving | Shipped | `composables/useLabelScan.ts`, `composables/useScanMatchers.ts`, `db/ocrPicking.ts`, `components/LabelScanReviewModal.vue`, `utils/parseOcrScan.ts`, `components/CandidateChips.vue` | [ai-scope](../flows/picking/ai-scope.md) |
| Picking issue reporting | Picking | Shipped | `components/PickingIssueReportModal.vue`, `components/ReportIssueModal.vue` | [ai-scope](../flows/picking/ai-scope.md) |
| Receiving list | Receiving | Shipped | `pages/receiving/index.vue` | [ai-scope](../flows/receiving/ai-scope.md) |
| Receiving detail | Receiving | Shipped | `pages/receiving/[id].vue` or equivalent | [ai-scope](../flows/receiving/ai-scope.md) |
| Receiving mismatch | Receiving | Shipped | `components/ReportIssueModal.vue`, `db/receiving.ts` | [ai-scope](../flows/receiving/ai-scope.md) |
| Pending picking count badge | Receiving | Shipped | `pages/receiving/index.vue`, `db/receiving.ts` | [ai-scope](../flows/receiving/ai-scope.md) |
| Put-away list | Put-away | Shipped | `pages/put-away/index.vue` | [ai-scope](../flows/put-away/ai-scope.md) |
| Put-away detail | Put-away | Shipped | `pages/put-away/[id].vue` or equivalent | [ai-scope](../flows/put-away/ai-scope.md) |
| Shelf selection | Put-away | Shipped | `components/SelectShelfDialog.vue` | [ai-scope](../flows/put-away/ai-scope.md) |
| Measuring list | Measuring | Shipped | `pages/measuring/index.vue` | [ai-scope](../flows/measuring/ai-scope.md) |
| Measuring detail | Measuring | Shipped | `pages/measuring/[id].vue` or equivalent | [ai-scope](../flows/measuring/ai-scope.md) |
| Box measurements | Measuring | Shipped | `components/BoxMeasurementsModal.vue`, `db/measuring.ts` | [ai-scope](../flows/measuring/ai-scope.md) |
| Goods verify list | Goods Verify | Shipped | `pages/goods-verify/index.vue` | [ai-scope](../flows/goods-verify/ai-scope.md) |
| Goods verify detail | Goods Verify | Shipped | `pages/goods-verify/[id].vue` or equivalent | [ai-scope](../flows/goods-verify/ai-scope.md) |
| Stock Search | — | Shipped | `pages/stock-search/index.vue`, `db/stockSearch.ts` | [ai-scope](../flows/stock-search/ai-scope.md) |
| Login | Auth | Shipped | `pages/login.vue`, `composables/useAuth.ts` | [roles](../concepts/roles.md) |
| Language switcher | Shared | Shipped | `components/LanguageSwitcher.vue`, `app.vue`, `i18n/` | [navigation](../concepts/navigation.md) |
| Measuring task created toast | Picking / Shared | Shipped | `components/ToastHost.vue`, `composables/useToast.ts`, `pages/picking/[id].vue` | [picking ai-scope](../flows/picking/ai-scope.md) |

## Status legend

- **Shipped** — feature exists in the current demo.
- **Planned** — not part of this documentation system; see `docs/superpowers/plans/`.
