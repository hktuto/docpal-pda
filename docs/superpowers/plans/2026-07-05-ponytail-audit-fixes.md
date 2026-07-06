# Ponytail Audit Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the ponytail-audit findings, removing dead code, inlining YAGNI abstractions, and extracting duplicated helpers, while keeping `uuid`.

**Architecture:** Keep the existing Nuxt 3 + PGlite + Drizzle stack. Changes are deletions, inlining, and small extractions into `utils/` and `db/helpers.ts`. No behavior changes.

**Tech Stack:** Nuxt 3, Vue 3, TypeScript, PGlite, Drizzle ORM, Capacitor.

---

## File map

| File | Responsibility after changes |
|------|------------------------------|
| `package.json` | Remove `sharp` and related scripts if unused. Keep `uuid`. |
| `scripts/generate-native-assets.mjs` | Delete. Pre-generated `resources/` files remain. |
| `components/LoadingOverlay.vue` | Delete. |
| `components/StatusBadge.vue` | Delete; inline call sites. |
| `composables/useLocalePreference.ts` | Delete; inline into `app.vue`. |
| `composables/useAndroidBackButton.ts` | Delete; inline into `app.vue`. |
| `composables/useLogStateLabel.ts` | Delete; inline into callers. |
| `composables/useScanMatchers.ts` | Remove optional `matchers` fallback; simplify `error` overloads; merge `rawCode` into shared util. |
| `components/SelectShelfDialog.vue` | Use `schema.shelves.$inferSelect` instead of local `Shelf`. |
| `utils/text.ts` (new) | Shared text normalization: `normalizeString`, `rawCode`. |
| `utils/ids.ts` (new) | Shared `generateLocationBoxId(prefix, locationCode)` helper. |
| `db/helpers.ts` (new) | Shared SQL expression/CTE for available receiving quantity. |
| `utils/log.ts` (new) | Shared `logMetadataText`. |
| `utils/box.ts` (new) | Shared `boxTotalQty`. |
| `composables/useLabelScan.ts` | Inline `ocrResultToInput` and `parseBrowserScanPromptJson`. |
| `utils/ocrResultToInput.ts` | Delete. |
| `utils/parseBrowserScanPromptJson.ts` | Delete. |
| `db/picking.ts` | Remove unused functions; use shared ID helper; remove `locationCode` default. |
| `db/putAway.ts` | Use shared ID helper; remove `locationCode` default; use shared available-qty helper. |
| `db/receiving.ts` | Use shared available-qty helper. |
| `db/ocrPicking.ts` | Use shared available-qty helper. |
| `db/stockSearch.ts` | Remove unused `getAllSuppliers`. |
| `pages/measuring/[id].vue` | Replace manual visibility wiring with `useVisibleReload(load)`. |
| `pages/receiving/index.vue` | Use shared available-qty helper. |
| `pages/receiving/[id].vue` | Use shared available-qty helper. |
| `plugins/pglite.client.ts` | Remove unused `live` extension. |
| `i18n/locales/*.ts` | Remove dead keys. |
| `components/ReportIssueModal.vue` | Simplify `toNumberOrNull`. |
| `assets:prepare` / `assets:android` scripts | Re-point to `npx capacitor-assets generate` or remove if resources are pre-generated. |

---

## Task 1: Remove `sharp` and native-assets script

**Files:**
- Delete: `scripts/generate-native-assets.mjs`
- Modify: `package.json`
- Modify: `capacitor.config.ts` (if `assets:prepare` script referenced)

**Context:** `resources/` already contains the generated PNGs. The `sharp` script is a one-time generator, not needed at build/dev time. `npx capacitor-assets generate` is already available via `@capacitor/assets` if regen is needed.

- [ ] **Step 1: Delete `scripts/generate-native-assets.mjs`**

```bash
rm scripts/generate-native-assets.mjs
```

- [ ] **Step 2: Remove `sharp` from `package.json` and update asset scripts**

In `package.json`:

```json
{
  "scripts": {
    "assets:prepare": "node scripts/generate-native-assets.mjs",
    "assets:generate": "npx capacitor-assets generate --android --assetPath resources",
    "assets:android": "pnpm assets:prepare && pnpm assets:generate"
  },
  "devDependencies": {
    "sharp": "^0.35.3"
  }
}
```

Change to:

```json
{
  "scripts": {
    "assets:generate": "npx capacitor-assets generate --android --assetPath resources",
    "assets:android": "pnpm assets:generate"
  },
  "devDependencies": {
  }
}
```

- [ ] **Step 3: Run `pnpm install` to update lockfile**

```bash
export PATH="/c/Program Files/nodejs:$PATH" && pnpm install
```

Expected: lockfile updates, no errors.

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml scripts/
git commit -m "chore: remove sharp and generate-native-assets script"
```

---

## Task 2: Remove unused code

**Files:**
- Modify: `db/picking.ts`
- Modify: `db/stockSearch.ts`
- Delete: `components/LoadingOverlay.vue`
- Modify: `plugins/pglite.client.ts`

- [ ] **Step 1: Remove `reportPickingItemMismatch` and `getInHandReceivingOrdersWithSupplier` from `db/picking.ts`**

Delete these two exported functions (around lines 313 and 802). No callers exist.

- [ ] **Step 2: Remove `getAllSuppliers` from `db/stockSearch.ts`**

Delete the exported function at line 46. No callers exist.

- [ ] **Step 3: Delete `components/LoadingOverlay.vue`**

```bash
rm components/LoadingOverlay.vue
```

- [ ] **Step 4: Remove `live` extension from `plugins/pglite.client.ts`**

Current:

```ts
import { PGlite } from "@electric-sql/pglite";
import { live } from "@electric-sql/pglite/live";

const pg = new PGlite({ extensions: { live } });
```

Change to:

```ts
import { PGlite } from "@electric-sql/pglite";

const pg = new PGlite();
```

- [ ] **Step 5: Run `pnpm nuxt prepare` to verify types**

```bash
export PATH="/c/Program Files/nodejs:$PATH" && pnpm nuxt prepare
```

Expected: types generated with no errors.

- [ ] **Step 6: Commit**

```bash
git add db/picking.ts db/stockSearch.ts components/LoadingOverlay.vue plugins/pglite.client.ts
git commit -m "chore: remove unused code and pglite/live extension"
```

---

## Task 3: Remove dead i18n keys

**Files:**
- Modify: `i18n/locales/en-US.ts`
- Modify: `i18n/locales/zh-CN.ts`
- Modify: `i18n/locales/zh-HK.ts`

**Keys to remove from all three files:**

- `common.backToAllShelves`
- `common.backToShelfBoxes`
- `receiving.detail.confirmingArrival`
- `goodsVerify.noZone`
- `errors.login_failed`
- `stockSearch.location`
- `stockSearch.shelf`
- `stockSearch.box`
- `stockSearch.receivingArea`

- [ ] **Step 1: Remove keys from `i18n/locales/en-US.ts`**

- [ ] **Step 2: Remove corresponding keys from `i18n/locales/zh-CN.ts` and `i18n/locales/zh-HK.ts`**

- [ ] **Step 3: Search to confirm keys are unused**

```bash
grep -R "backToAllShelves\|backToShelfBoxes\|confirmingArrival\|noZone\|errors.login_failed\|stockSearch.location\|stockSearch.shelf\|stockSearch.box\|stockSearch.receivingArea" --include="*.vue" --include="*.ts" .
```

Expected: no matches.

- [ ] **Step 4: Commit**

```bash
git add i18n/locales/
git commit -m "chore: remove dead i18n keys"
```

---

## Task 4: Inline YAGNI abstractions

### 4.1 Inline `StatusBadge.vue`

**Files:**
- Delete: `components/StatusBadge.vue`
- Modify: callers of `StatusBadge`

Find all usages with:

```bash
grep -R "StatusBadge" --include="*.vue" .
```

Replace each:

```vue
<StatusBadge :status="someStatus" />
```

with:

```vue
<span class="badge" :class="badgeClass(someStatus)">{{ statusLabel.picking(someStatus) }}</span>
```

If the caller already imports `badgeClass` from `~/composables/useStatusBadge`, reuse it; otherwise add the import.

- [ ] **Step 1: Find all `StatusBadge` usages and inline them**

- [ ] **Step 2: Delete `components/StatusBadge.vue`**

```bash
rm components/StatusBadge.vue
```

- [ ] **Step 3: Commit**

```bash
git add components/StatusBadge.vue [callers]
git commit -m "refactor: inline StatusBadge component"
```

### 4.2 Inline `useLocalePreference`

**Files:**
- Delete: `composables/useLocalePreference.ts`
- Modify: `app.vue`

Current `app.vue`:

```vue
<script setup lang="ts">
useAndroidBackButton();

onMounted(() => {
  useLocalePreference().restore();
});
</script>
```

Change `app.vue` to:

```vue
<script setup lang="ts">
useAndroidBackButton();

const SUPPORTED_LOCALES = ["en-US", "zh-CN", "zh-HK"] as const;
type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];
const STORAGE_KEY = "warehouse-locale";

const { locale, setLocale } = useI18n();

onMounted(() => {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved && SUPPORTED_LOCALES.includes(saved as SupportedLocale)) {
    setLocale(saved as SupportedLocale);
  }
});

watch(locale, (code) => {
  if (SUPPORTED_LOCALES.includes(code as SupportedLocale)) {
    localStorage.setItem(STORAGE_KEY, code);
  }
});
</script>
```

- [ ] **Step 1: Update `app.vue`**

- [ ] **Step 2: Delete `composables/useLocalePreference.ts`**

```bash
rm composables/useLocalePreference.ts
```

- [ ] **Step 3: Commit**

```bash
git add app.vue composables/useLocalePreference.ts
git commit -m "refactor: inline locale preference into app.vue"
```

### 4.3 Inline `useAndroidBackButton`

**Files:**
- Delete: `composables/useAndroidBackButton.ts`
- Modify: `app.vue`

Add to `app.vue` (after locale code):

```ts
import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";

let lastBackAt = 0;
const DOUBLE_TAP_MS = 2000;

if (Capacitor.isNativePlatform()) {
  const router = useRouter();
  App.addListener("backButton", ({ canGoBack }) => {
    if (canGoBack) {
      router.back();
      return;
    }
    const now = Date.now();
    if (now - lastBackAt < DOUBLE_TAP_MS) {
      App.exitApp();
    } else {
      lastBackAt = now;
    }
  });
}
```

Remove `useAndroidBackButton();` call.

- [ ] **Step 1: Update `app.vue`**

- [ ] **Step 2: Delete `composables/useAndroidBackButton.ts`**

```bash
rm composables/useAndroidBackButton.ts
```

- [ ] **Step 3: Commit**

```bash
git add app.vue composables/useAndroidBackButton.ts
git commit -m "refactor: inline android back button handling into app.vue"
```

### 4.4 Inline `useLogStateLabel`

**Files:**
- Delete: `composables/useLogStateLabel.ts`
- Modify: `components/picking/PickingItemsSection.vue`
- Modify: `components/receiving/ReceivingPickingTab.vue`

In each file, replace:

```ts
const logStateLabel = useLogStateLabel();
```

with:

```ts
const { t } = useI18n();
const logStateLabel = (code: string | null | undefined) =>
  code ? t(`logStates.${code}`) : t("common.stateNone");
```

Remove `import { useLogStateLabel } from "~/composables/useLogStateLabel";`.

- [ ] **Step 1: Update `components/picking/PickingItemsSection.vue`**

- [ ] **Step 2: Update `components/receiving/ReceivingPickingTab.vue`**

- [ ] **Step 3: Delete `composables/useLogStateLabel.ts`**

```bash
rm composables/useLogStateLabel.ts
```

- [ ] **Step 4: Commit**

```bash
git add components/picking/PickingItemsSection.vue components/receiving/ReceivingPickingTab.vue composables/useLogStateLabel.ts
git commit -m "refactor: inline useLogStateLabel"
```

### 4.5 Replace local `Shelf` interface in `SelectShelfDialog.vue`

**Files:**
- Modify: `components/SelectShelfDialog.vue`

Current:

```ts
interface Shelf {
  code: string;
  zone: string | null;
}

const props = defineProps<{
  modelValue: boolean;
  shelves: Shelf[];
}>();
```

Change to:

```ts
import * as schema from "~/db/schema";

const props = defineProps<{
  modelValue: boolean;
  shelves: (typeof schema.shelves.$inferSelect)[];
}>();
```

- [ ] **Step 1: Update `components/SelectShelfDialog.vue`**

- [ ] **Step 2: Verify callers pass compatible data**

Search callers with:

```bash
grep -R "SelectShelfDialog" --include="*.vue" .
```

Expected: callers already pass shelf rows from the schema.

- [ ] **Step 3: Commit**

```bash
git add components/SelectShelfDialog.vue
git commit -m "refactor: use schema type for SelectShelfDialog shelves"
```

### 4.6 Remove optional `matchers` fallback in `runScanMatcher`

**Files:**
- Modify: `composables/useScanMatchers.ts`
- Modify: `composables/useLabelScan.ts`

Current signature:

```ts
export async function runScanMatcher(
  ctx: ScanTaskContext,
  parsed: OcrInput,
  matchers?: ScanMatchers
): Promise<ScanMatchResult> {
  const m = matchers ?? useScanMatchers();
  ...
}
```

Change to required:

```ts
export async function runScanMatcher(
  ctx: ScanTaskContext,
  parsed: OcrInput,
  matchers: ScanMatchers
): Promise<ScanMatchResult> {
  const m = matchers;
  ...
}
```

In `useLabelScan.ts`, the call already passes `matchers`, so no change.

- [ ] **Step 1: Update `composables/useScanMatchers.ts`**

- [ ] **Step 2: Commit**

```bash
git add composables/useScanMatchers.ts
git commit -m "refactor: make matchers parameter required in runScanMatcher"
```

---

## Task 5: Extract shared helpers

### 5.1 Shared box/shelf-box ID generation

**Files:**
- Create: `utils/ids.ts`
- Modify: `db/picking.ts`
- Modify: `db/putAway.ts`

Create `utils/ids.ts`:

```ts
import { getIsoWeek } from "~/db/date";

export function generateLocationBoxId(
  prefix: string,
  locationCode: string,
  existingIds: string[]
): string {
  const now = new Date();
  const week = String(getIsoWeek(now)).padStart(2, "0");
  const year = String(now.getFullYear() % 100).padStart(2, "0");
  const idPrefix = `${prefix}-${locationCode}-${week}${year}`;

  let maxSeq = 0;
  const regex = new RegExp(`^${idPrefix.replace(/[-]/g, "\\-")}([0-9]{6})$`);
  for (const id of existingIds) {
    const match = id.match(regex);
    if (match) maxSeq = Math.max(maxSeq, parseInt(match[1], 10));
  }

  return `${idPrefix}${String(maxSeq + 1).padStart(6, "0")}`;
}
```

In `db/picking.ts`, replace `createShippingBoxForPickingOrder` local generation with:

```ts
import { generateLocationBoxId } from "~/utils/ids";

const existing = await tx
  .select({ id: schema.shippingBoxes.id })
  .from(schema.shippingBoxes)
  .where(sql`${schema.shippingBoxes.id} LIKE ${prefix + "%"}`);

const boxId = generateLocationBoxId(prefix, locationCode, existing.map((r) => r.id));
```

In `db/putAway.ts`, replace `generateShelfBoxId` with the same helper.

- [ ] **Step 1: Create `utils/ids.ts`**

- [ ] **Step 2: Refactor `db/picking.ts`**

- [ ] **Step 3: Refactor `db/putAway.ts`**

- [ ] **Step 4: Run `pnpm nuxt prepare`**

- [ ] **Step 5: Commit**

```bash
git add utils/ids.ts db/picking.ts db/putAway.ts
git commit -m "refactor: extract shared location box id generator"
```

### 5.2 Shared available-quantity expression

**Files:**
- Create: `db/helpers.ts`
- Modify: `db/receiving.ts`
- Modify: `db/putAway.ts`
- Modify: `db/ocrPicking.ts`
- Modify: `pages/receiving/index.vue`
- Modify: `pages/receiving/[id].vue`

Create `db/helpers.ts`:

```ts
import { sql } from "drizzle-orm";

export const availableReceivingQtySql = sql`
  rii.received_qty - rii.picked_qty - rii.put_away_qty - COALESCE(alloc.allocated_qty, 0)
`;

export function allocationsCte() {
  return sql`
    SELECT receiving_invoice_item_id, SUM(qty) AS allocated_qty
    FROM allocations
    WHERE receiving_invoice_item_id IS NOT NULL
    GROUP BY receiving_invoice_item_id
  `;
}
```

Replace repeated raw SQL expressions in the files above with imports from `db/helpers.ts`. For Drizzle `sql` templates, import and interpolate:

```ts
import { availableReceivingQtySql, allocationsCte } from "~/db/helpers";

// example usage in a query
WHERE ${availableReceivingQtySql} > 0
```

- [ ] **Step 1: Create `db/helpers.ts`**

- [ ] **Step 2: Replace expressions in `db/receiving.ts`, `db/putAway.ts`, `db/ocrPicking.ts`**

- [ ] **Step 3: Replace expressions in `pages/receiving/index.vue` and `pages/receiving/[id].vue`**

- [ ] **Step 4: Run tests and type check**

```bash
export PATH="/c/Program Files/nodejs:$PATH" && pnpm nuxt prepare && pnpm test
```

Expected: no type errors, tests pass.

- [ ] **Step 5: Commit**

```bash
git add db/helpers.ts db/receiving.ts db/putAway.ts db/ocrPicking.ts pages/receiving/index.vue pages/receiving/[id].vue
git commit -m "refactor: extract shared available-receiving-qty helper"
```

---

## Task 6: Merge duplicated helpers

### 6.1 Merge text normalization helpers

**Files:**
- Create: `utils/text.ts`
- Modify: `composables/useScanMatchers.ts`
- Modify: `db/measuring.ts`
- Modify: `composables/useMockOcr.ts` (if `normalize`/`normalizeCode` can be replaced)

Create `utils/text.ts`:

```ts
export function normalizeString(value: string | null | undefined): string | null {
  if (value == null) return null;
  const s = String(value).trim();
  return s || null;
}

export function rawCode(value: unknown): string | null {
  if (value == null) return null;
  const s = String(value).trim();
  return s || null;
}
```

Replace `rawCode` in `useScanMatchers.ts` and `normalizeString` in `db/measuring.ts` with imports from `utils/text.ts`.

- [ ] **Step 1: Create `utils/text.ts`**

- [ ] **Step 2: Update `composables/useScanMatchers.ts`**

- [ ] **Step 3: Update `db/measuring.ts`**

- [ ] **Step 4: Commit**

```bash
git add utils/text.ts composables/useScanMatchers.ts db/measuring.ts
git commit -m "refactor: merge rawCode/normalizeString into utils/text"
```

### 6.2 Merge `logMetadataText`

**Files:**
- Create: `utils/log.ts`
- Modify: `components/picking/PickingItemsSection.vue`
- Modify: `components/receiving/ReceivingPickingTab.vue`

Create `utils/log.ts`:

```ts
export function logMetadataText(metadata: string | null): string | number | undefined {
  if (!metadata) return undefined;
  const parsed = JSON.parse(metadata);
  return parsed.qty ?? parsed.note;
}
```

Replace local helpers in both components with import.

- [ ] **Step 1: Create `utils/log.ts`**

- [ ] **Step 2: Update both components**

- [ ] **Step 3: Commit**

```bash
git add utils/log.ts components/picking/PickingItemsSection.vue components/receiving/ReceivingPickingTab.vue
git commit -m "refactor: extract shared logMetadataText helper"
```

### 6.3 Merge `boxTotalQty`

**Files:**
- Create: `utils/box.ts`
- Modify: `components/picking/PickingBoxesSection.vue`
- Modify: `components/put-away/ShelfBoxesPanel.vue`

Create `utils/box.ts`:

```ts
export function boxTotalQty(items: { qty: number }[]): number {
  return items.reduce((sum, item) => sum + item.qty, 0);
}
```

Replace local helpers in both components.

- [ ] **Step 1: Create `utils/box.ts`**

- [ ] **Step 2: Update both components**

- [ ] **Step 3: Commit**

```bash
git add utils/box.ts components/picking/PickingBoxesSection.vue components/put-away/ShelfBoxesPanel.vue
git commit -m "refactor: extract shared boxTotalQty helper"
```

---

## Task 7: Inline single-export scan utils into `useLabelScan`

**Files:**
- Modify: `composables/useLabelScan.ts`
- Delete: `utils/ocrResultToInput.ts`
- Delete: `utils/parseBrowserScanPromptJson.ts`

Move the bodies of `ocrResultToInput` and `parseBrowserScanPromptJson` into `useLabelScan.ts` as private helpers.

```ts
function ocrResultToInput(parsed: ParsedFields): OcrInput {
  return {
    partNo: parsed.itemId ?? "",
    dateCode: parsed.dateCode ?? "",
    lotCode: parsed.lotCode ?? "",
    coo: parsed.coo ?? "",
    cow: parsed.cow ?? "",
    qty: parsed.qty ?? "",
  };
}

function isBarcodeItem(b: unknown): b is OcrBarcode {
  return (
    typeof b === "object" &&
    b !== null &&
    typeof (b as Record<string, unknown>).value === "string" &&
    typeof (b as Record<string, unknown>).format === "string"
  );
}

function parseBrowserScanPromptJson(raw: string): LabelScanCapture | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.text !== "string") return null;
  const barcodes = Array.isArray(obj.barcodes) ? obj.barcodes : [];
  if (!barcodes.every(isBarcodeItem)) return null;
  return {
    imagePath: "",
    text: obj.text,
    barcodes: JSON.stringify(barcodes),
  };
}
```

Remove imports of the deleted files from `useLabelScan.ts`.

- [ ] **Step 1: Update `composables/useLabelScan.ts`**

- [ ] **Step 2: Delete `utils/ocrResultToInput.ts` and `utils/parseBrowserScanPromptJson.ts`**

```bash
rm utils/ocrResultToInput.ts utils/parseBrowserScanPromptJson.ts
```

- [ ] **Step 3: Update tests**

Move tests from `tests/ocrResultToInput.test.ts` and `tests/parseBrowserScanPromptJson.test.ts` into a new `tests/useLabelScan.test.ts` file, or delete them if the functions are now private. Prefer moving them.

- [ ] **Step 4: Run tests**

```bash
export PATH="/c/Program Files/nodejs:$PATH" && pnpm test
```

- [ ] **Step 5: Commit**

```bash
git add composables/useLabelScan.ts utils/ocrResultToInput.ts utils/parseBrowserScanPromptJson.ts tests/
git commit -m "refactor: inline scan parsing helpers into useLabelScan"
```

---

## Task 8: Simplify remaining functions

### 8.1 Use `useVisibleReload` in `pages/measuring/[id].vue`

**Files:**
- Modify: `pages/measuring/[id].vue`

Current manual wiring:

```ts
function onVisible() {
  if (document.visibilityState === "visible") {
    load();
  }
}

onMounted(() => {
  load();
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", onVisible);
});

onUnmounted(() => {
  document.removeEventListener("visibilitychange", onVisible);
  window.removeEventListener("focus", onVisible);
});
```

Replace with:

```ts
import { useVisibleReload } from "~/composables/useVisibleReload";

onMounted(load);
useVisibleReload(load);
```

- [ ] **Step 1: Update `pages/measuring/[id].vue`**

- [ ] **Step 2: Commit**

```bash
git add pages/measuring/[id].vue
git commit -m "refactor: use useVisibleReload in measuring detail"
```

### 8.2 Simplify `useScanMatchers.error` overloads

**Files:**
- Modify: `composables/useScanMatchers.ts`

Current:

```ts
function error(err: I18nError): ScanMatchResult;
function error(code: string, params?: Record<string, unknown>): ScanMatchResult;
function error(arg: I18nError | string, params?: Record<string, unknown>): ScanMatchResult {
  if (arg instanceof I18nError) {
    return { type: "error", message: t(`errors.${arg.code}`, (arg.params ?? {}) as Record<string, unknown>) };
  }
  return { type: "error", message: t(`errors.${arg}`, params ?? {}) };
}
```

Change to:

```ts
function error(arg: I18nError | string, params?: Record<string, unknown>): ScanMatchResult {
  if (arg instanceof I18nError) {
    return { type: "error", message: t(`errors.${arg.code}`, (arg.params ?? {}) as Record<string, unknown>) };
  }
  return { type: "error", message: t(`errors.${arg}`, params ?? {}) };
}
```

Remove the interface overload declarations at lines 109-110.

- [ ] **Step 1: Update `composables/useScanMatchers.ts`**

- [ ] **Step 2: Commit**

```bash
git add composables/useScanMatchers.ts
git commit -m "refactor: simplify useScanMatchers.error overloads"
```

### 8.3 Simplify `toNumberOrNull` in `ReportIssueModal.vue`

**Files:**
- Modify: `components/ReportIssueModal.vue`

Current:

```ts
function toNumberOrNull(v: unknown): number | null {
  if (v === "" || v === null || v === undefined || Number.isNaN(Number(v))) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
```

Change to:

```ts
function toNumberOrNull(v: unknown): number | null {
  const n = v === "" || v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n : null;
}
```

- [ ] **Step 1: Update `components/ReportIssueModal.vue`**

- [ ] **Step 2: Commit**

```bash
git add components/ReportIssueModal.vue
git commit -m "refactor: simplify toNumberOrNull"
```

### 8.4 Remove `locationCode` default parameters

**Files:**
- Modify: `db/picking.ts`
- Modify: `db/putAway.ts`

Current defaults are `locationCode = "HK1"`. Since no caller passes a different value, remove the parameter and hardcode `"HK1"` inside the helpers (or use the shared ID helper from Task 5.1 which already takes `locationCode`).

In `db/picking.ts`:

```ts
export async function createShippingBoxForPickingOrder(
  db: PgliteDatabase<typeof schema>,
  pickingOrderId: string,
  actorId: string
): Promise<string> {
  const locationCode = "HK1";
  ...
}
```

In `db/putAway.ts`:

```ts
async function generateShelfBoxId(
  tx: PgliteDatabase<typeof schema>
): Promise<string> {
  return generateLocationBoxId("SBOX", "HK1", existing.map((r) => r.id));
}

export async function createShelfBox(
  ...,
  actorId: string
): Promise<...> {
  const locationCode = "HK1";
  ...
}
```

- [ ] **Step 1: Update `db/picking.ts`**

- [ ] **Step 2: Update `db/putAway.ts`**

- [ ] **Step 3: Commit**

```bash
git add db/picking.ts db/putAway.ts
git commit -m "refactor: remove unused locationCode parameter defaults"
```

---

## Task 9: Locale simplification (optional)

**Files:**
- Modify: `i18n/locales/en-US.ts`
- Modify: `i18n/locales/zh-CN.ts`
- Modify: `i18n/locales/zh-HK.ts`

**Approach:** Instead of maintaining three full nested objects, derive `zh-CN` and `zh-HK` from `en-US` by replacing only the translated leaf strings. This is a larger change; skip if it risks breaking i18n tooling.

Recommended minimal version: keep the nested files but extract a shared recursive `mergeLocale(base, overrides)` helper in `i18n/config.ts` and store only the diffs for `zh-CN`/`zh-HK`.

- [ ] **Step 1: Decide whether to do this task** (if not, mark skipped)

- [ ] **Step 2: Implement derivation helper if proceeding**

- [ ] **Step 3: Commit**

```bash
git add i18n/
git commit -m "refactor: derive zh-CN/zh-HK locales from en-US"
```

---

## Task 10: Final verification

- [ ] **Step 1: Run full type check**

```bash
export PATH="/c/Program Files/nodejs:$PATH" && pnpm nuxt prepare
```

Expected: types generated, no errors.

- [ ] **Step 2: Run tests**

```bash
export PATH="/c/Program Files/nodejs:$PATH" && pnpm test
```

Expected: all tests pass.

- [ ] **Step 3: Generate and sync Android assets**

```bash
export PATH="/c/Program Files/nodejs:$PATH" && pnpm generate && npx cap sync android
```

Expected: build succeeds, assets copied.

- [ ] **Step 4: Install debug APK on connected device**

```bash
export JAVA_HOME='/c/Program Files/Android/Android Studio/jbr'
export PATH="$JAVA_HOME/bin:$PATH"
cd android && ./gradlew :app:installDebug
```

Expected: `Installed on 1 device.`

- [ ] **Step 5: Smoke test on Android**

Launch app:

```bash
/d/android/platform-tools/adb.exe shell am start -n com.docpal.warehousedemo/.MainActivity
```

Log in as `operator` / `DocPal2026!` and verify:
- Header title is left-aligned.
- Receiving list loads.
- Receiving detail opens quickly, picking tab loads in background.
- No console errors in logcat.

- [ ] **Step 6: Final commit**

```bash
git commit -m "chore: final verification after ponytail audit fixes" --allow-empty
```

---

## Self-review

**Spec coverage:** Each ponytail-audit finding (except `uuid` → `crypto.randomUUID`) maps to a task:
- `sharp` / native assets → Task 1
- Unused functions/component/live extension → Task 2
- Dead i18n keys → Task 3
- YAGNI abstractions → Task 4
- Shared helpers (box ID, available qty) → Task 5
- Duplicated helpers → Task 6
- Single-export scan utils → Task 7
- Simplifications → Task 8
- Locale simplification → Task 9 (optional)

**Placeholder scan:** No TBD/TODO placeholders in code steps. The only soft item is Task 9, explicitly marked optional.

**Type consistency:** Shared helpers use existing schema types. `normalizedString` returns `string | null` consistently. `generateLocationBoxId` signature matches the two existing use sites.

**Estimated net:** ~-250 lines, -1 dep (`sharp`).
