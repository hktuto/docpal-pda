# Page Component Separation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the largest Nuxt detail pages thin controllers by extracting shared presentational primitives and page-specific components, without changing routes, user-facing behavior, or data flow.

**Architecture:** Keep pages responsible for route params, top-level data loading, and orchestrating actions. Move repeated markup into small auto-imported components under `components/`. Move duplicated lifecycle and status logic into focused composables under `composables/`. Page-specific sub-views live in `components/<page>/` so they are co-located with their only consumer.

**Tech Stack:** Nuxt 3 (`ssr: false`), Vue 3, TypeScript, PGlite/Drizzle, Capacitor.

---

## Current state

| Page | Lines (current) | Notes |
|---|---|---|
| `pages/receiving/[id].vue` | 891 | Two tabs, scan, box/package management, mismatch reporting, logs |
| `pages/picking/[id].vue` | 599 | Header, boxes, items, allocations, packages, logs, mismatch reporting |
| `pages/put-away/[id].vue` | 474 | Shelf boxes, available lots, scan |
| `pages/measuring/[taskId]/box/[boxId].vue` | 287 | Packages, measurements, scan |
| `pages/goods-verify/box/[id].vue` | 264 | Expected items, scan, verification |

All pages have grown since the original draft. The duplication that most actively hurts readability is:

- `.detail-row` / `.detail-label` markup and styles copied in every page.
- `badgeClass(status)` logic copied in five files.
- `onMounted`/`onUnmounted` visibility/focus reload wiring copied in every detail page.
- Floating scan FAB markup and styles copied in four pages.
- The receiving and picking pages each contain multiple distinct sub-views in one template.

## File structure

New files to create:

- `composables/useVisibleReload.ts` — Capacitor-friendly reload-on-foreground lifecycle.
- `composables/useStatusBadge.ts` — central `badgeClass(status)` helper.
- `composables/useLabelScanReview.ts` — shared scan-review modal state machine.
- `components/DetailRow.vue` — label/value row.
- `components/StatusBadge.vue` — status badge with centralized class mapping.
- `components/ScanFab.vue` — floating circular scan button.
- `components/EmptyState.vue` — loading/error/empty message.
- `components/receiving/ReceivingItemsTab.vue` — receiving tab of `pages/receiving/[id].vue`.
- `components/receiving/ReceivingPickingTab.vue` — picking tab of `pages/receiving/[id].vue`.
- `components/picking/PickingBoxesSection.vue` — boxes panel of `pages/picking/[id].vue`.
- `components/picking/PickingItemsSection.vue` — items panel of `pages/picking/[id].vue`.
- `components/put-away/ShelfBoxesPanel.vue` — shelf boxes panel of `pages/put-away/[id].vue`.
- `components/put-away/PutAwayLotsPanel.vue` — available lots panel of `pages/put-away/[id].vue`.

Files to modify:

- `pages/receiving/[id].vue`
- `pages/picking/[id].vue`
- `pages/put-away/[id].vue`
- `pages/measuring/[taskId]/box/[boxId].vue`
- `pages/goods-verify/box/[id].vue`
- `pages/receiving/index.vue`
- `pages/put-away/index.vue`
- `pages/picking/index.vue`
- `pages/goods-verify/shelf/[code].vue`
- `assets/css/main.css`

---

## Phase 0 — Shared primitives

### Task 1: Create `composables/useVisibleReload.ts`

**Files:**
- Create: `composables/useVisibleReload.ts`

**Why:** Every Capacitor detail/list page repeats the same `onMounted`/`onUnmounted` + `visibilitychange`/`focus` wiring.

- [ ] **Step 1: Write the composable**

```ts
export function useVisibleReload(load: () => void | Promise<void>) {
  async function onVisible() {
    if (document.visibilityState === "visible") {
      await load();
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
}
```

- [ ] **Step 2: Verify with `pnpm nuxt prepare`**

Run: `pnpm nuxt prepare`
Expected: no TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add composables/useVisibleReload.ts
git commit -m "feat: add useVisibleReload composable for Capacitor detail pages"
```

### Task 2: Create `composables/useStatusBadge.ts`

**Files:**
- Create: `composables/useStatusBadge.ts`

**Why:** `badgeClass(status)` is duplicated in `pages/receiving/[id].vue`, `pages/receiving/index.vue`, `pages/put-away/[id].vue`, `pages/put-away/index.vue`, `pages/picking/index.vue`, `pages/goods-verify/box/[id].vue`, and `pages/goods-verify/shelf/[code].vue`. The global CSS already has `.badge--pending`, `.badge--in-hand`, `.badge--finished`, and `.badge--danger`; we just need one function.

- [ ] **Step 1: Write the composable**

```ts
export function useStatusBadge() {
  function badgeClass(status: string | null | undefined): string {
    const s = (status ?? "").toLowerCase().replace(/_/g, "-");
    if (s === "pending" || s === "open") return "badge--pending";
    if (s === "in-hand" || s === "picking") return "badge--in-hand";
    if (["finished", "completed", "verified", "closed", "clear", "done"].includes(s)) {
      return "badge--finished";
    }
    if (s === "issue" || s === "danger") return "badge--danger";
    return "";
  }

  return { badgeClass };
}
```

- [ ] **Step 2: Verify with `pnpm nuxt prepare`**

Run: `pnpm nuxt prepare`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add composables/useStatusBadge.ts
git commit -m "feat: add useStatusBadge composable"
```

### Task 3: Create `composables/useLabelScanReview.ts`

**Files:**
- Create: `composables/useLabelScanReview.ts`

**Why:** The scan → review/manual modal wiring is repeated in `receiving/[id].vue`, `picking/[id].vue`, `put-away/[id].vue`, `measuring/[taskId]/box/[boxId].vue`, and `goods-verify/box/[id].vue`. Extract the common state and handlers so pages only provide the scan call and success callback.

- [ ] **Step 1: Write the composable**

```ts
import { useLabelScan, createManualReview, type LabelScanResult } from "~/composables/useLabelScan";

export interface UseLabelScanReviewOptions {
  onApplied?: () => void | Promise<void>;
}

export function useLabelScanReview(options: UseLabelScanReviewOptions = {}) {
  const { scan, scanning } = useLabelScan();
  const reviewOpen = ref(false);
  const review = ref<LabelScanResult | null>(null);

  async function handleResult(result: LabelScanResult) {
    if (result.status === "applied") {
      await options.onApplied?.();
    } else if (result.status === "review") {
      review.value = result;
      reviewOpen.value = true;
    } else if (result.status === "manual") {
      review.value = createManualReview();
      reviewOpen.value = true;
    }
  }

  async function onApplied() {
    reviewOpen.value = false;
    await options.onApplied?.();
  }

  return {
    scan,
    scanning,
    review,
    reviewOpen,
    handleResult,
    onApplied,
  };
}
```

- [ ] **Step 2: Verify with `pnpm nuxt prepare`**

Run: `pnpm nuxt prepare`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add composables/useLabelScanReview.ts
git commit -m "feat: add useLabelScanReview composable"
```

### Task 4: Create `components/DetailRow.vue`

**Files:**
- Create: `components/DetailRow.vue`

**Why:** The pattern `<div class="detail-row"><span class="detail-label">Label</span><span>Value</span></div>` appears 30+ times across detail pages.

- [ ] **Step 1: Write the component**

```vue
<template>
  <div class="detail-row">
    <span class="detail-label">{{ label }}</span>
    <span><slot>{{ displayValue }}</slot></span>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{
  label: string;
  value?: string | number | null;
}>();

const displayValue = computed(() => {
  if (props.value === null || props.value === undefined || props.value === "") {
    return "—";
  }
  return String(props.value);
});
</script>
```

- [ ] **Step 2: Verify with `pnpm nuxt prepare`**

Run: `pnpm nuxt prepare`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add components/DetailRow.vue
git commit -m "feat: add DetailRow component"
```

### Task 5: Create `components/StatusBadge.vue`

**Files:**
- Create: `components/StatusBadge.vue`

**Why:** Centralize badge markup and class logic. Pages that currently compute a class can just pass the status string.

- [ ] **Step 1: Write the component**

```vue
<template>
  <span class="badge" :class="badgeClass(status)">
    <slot>{{ status }}</slot>
  </span>
</template>

<script setup lang="ts">
const props = defineProps<{
  status: string;
}>();

const { badgeClass } = useStatusBadge();
</script>
```

- [ ] **Step 2: Verify with `pnpm nuxt prepare`**

Run: `pnpm nuxt prepare`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add components/StatusBadge.vue
git commit -m "feat: add StatusBadge component"
```

### Task 6: Create `components/ScanFab.vue`

**Files:**
- Create: `components/ScanFab.vue`

**Why:** The fixed-position circular scan button is copied inline in `receiving/[id].vue`, `picking/[id].vue`, `put-away/[id].vue`, `measuring/[taskId]/box/[boxId].vue`, and `goods-verify/box/[id].vue`.

- [ ] **Step 1: Write the component**

```vue
<template>
  <div class="scan-fab">
    <button
      class="btn"
      aria-label="Scan label"
      :disabled="loading"
      @click="$emit('click')"
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
        <circle cx="12" cy="13" r="4"/>
      </svg>
    </button>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  loading?: boolean;
}>();

defineEmits<{
  click: [];
}>();
</script>

<style scoped>
.scan-fab {
  position: fixed;
  bottom: 1.5rem;
  right: 1.5rem;
  z-index: 60;
}

.scan-fab .btn {
  border-radius: 9999px;
  width: 3.5rem;
  height: 3.5rem;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: var(--shadow);
}
</style>
```

- [ ] **Step 2: Verify with `pnpm nuxt prepare`**

Run: `pnpm nuxt prepare`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add components/ScanFab.vue
git commit -m "feat: add ScanFab component"
```

### Task 7: Create `components/EmptyState.vue`

**Files:**
- Create: `components/EmptyState.vue`

**Why:** The loading/error/empty trifecta is repeated on every page with slight styling differences.

- [ ] **Step 1: Write the component**

```vue
<template>
  <p class="empty" :class="{ 'empty--error': isError }" :style="inlineStyle">
    <slot>{{ message }}</slot>
  </p>
</template>

<script setup lang="ts">
const props = defineProps<{
  message?: string;
  error?: boolean;
}>();

const isError = computed(() => props.error);
const inlineStyle = computed(() => (props.error ? { color: "var(--danger)" } : undefined));
</script>

<style scoped>
.empty--error {
  color: var(--danger);
}
</style>
```

- [ ] **Step 2: Verify with `pnpm nuxt prepare`**

Run: `pnpm nuxt prepare`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add components/EmptyState.vue
git commit -m "feat: add EmptyState component"
```

---

## Phase 1 — Adopt shared primitives in the smallest pages

Do these first because they are low-risk and prove the primitives work before touching the largest files.

> **CSS note:** Page refactor tasks in this phase keep the existing scoped `.detail-row`, `.detail-label`, `.lot`, `.badge--*`, `.card--done`, and `.card--danger` styles so each commit remains visually correct. All of those scoped copies are removed together in Task 23 once the global utilities are added.

### Task 8: Refactor `pages/measuring/[taskId]/box/[boxId].vue`

**Files:**
- Modify: `pages/measuring/[taskId]/box/[boxId].vue`

**Goal:** Replace inline detail rows with `<DetailRow>`, inline scan FAB with `<ScanFab>`, inline loading/error with `<EmptyState>`, inline badge with `<StatusBadge>`, and lifecycle wiring with `useVisibleReload`. Remove scoped `.detail-row`, `.detail-label`, `.badge--finished`, and FAB styles.

- [ ] **Step 1: Update imports and script top**

Keep:

```ts
import { getShippingBoxForMeasuring, type ShippingBoxForMeasuring } from "~/db/measuring";
import BoxMeasurementsModal from "~/components/BoxMeasurementsModal.vue";
```

Remove the `useLabelScan` import and replace it with `useLabelScanReview`:

```ts
import { useLabelScanReview } from "~/composables/useLabelScanReview";
```

Define `onScanApplied` and `onRetake` as function declarations near the top of `<script setup>` (function declarations are hoisted, so they can be referenced by `useLabelScanReview`):

```ts
async function onScanApplied() {
  await load();
  if (allVerified.value && box.value?.status === "open") {
    measureOpen.value = true;
  }
}

async function onRetake() {
  reviewOpen.value = false;
  await openScan(scanTargetPackageId.value);
}
```

Replace:

```ts
const { scan, scanning } = useLabelScan();
const reviewOpen = ref(false);
const review = ref<LabelScanResult | null>(null);
```

with:

```ts
const {
  scan,
  scanning,
  review,
  reviewOpen,
  handleResult,
  onApplied,
} = useLabelScanReview({ onApplied: onScanApplied });
```

- [ ] **Step 2: Replace lifecycle wiring**

Remove the existing `onMounted`/`onUnmounted`/`onVisible` block and add:

```ts
useVisibleReload(load);
```

- [ ] **Step 3: Replace `openScan` scan-result handling**

Change `openScan` to:

```ts
async function openScan(packageId?: string) {
  if (!box.value) return;
  scanTargetPackageId.value = packageId;
  const result = await scan({
    task: "measuring",
    boxId,
    targetPackageId: packageId,
  });
  if (result.status === "error") {
    error.value = result.message;
  } else {
    await handleResult(result);
  }
}
```

Remove the old page-level `onScanApplied` function if it was defined elsewhere in the script (the hoisted definition above replaces it).

- [ ] **Step 4: Replace template blocks**

Loading/error block:

```vue
<EmptyState v-if="pending">Loading…</EmptyState>
<EmptyState v-else-if="error" error>Error: {{ error }}</EmptyState>
```

Scan FAB:

```vue
<ScanFab
  v-if="box.status === 'open'"
  :loading="scanning"
  @click="openScan()"
/>
```

Status badge for package:

```vue
<StatusBadge :status="pkg.verified ? 'verified' : 'pending'" />
```

Replace each `<div class="detail-row">…</div>` with `<DetailRow label="…" :value="…" />`.

- [ ] **Step 5: Remove scoped styles**

Remove only the inline floating scan button styles (the button is now `<ScanFab>`). Keep `.detail-row`, `.detail-label`, and `.badge--finished`; they are removed globally in Task 23.

- [ ] **Step 6: Verify**

Run: `pnpm nuxt prepare && pnpm generate`
Expected: build succeeds.

- [ ] **Step 7: Commit**

```bash
git add pages/measuring/[taskId]/box/[boxId].vue
git commit -m "refactor: adopt shared primitives in measuring box page"
```

### Task 9: Refactor `pages/goods-verify/box/[id].vue`

**Files:**
- Modify: `pages/goods-verify/box/[id].vue`

**Goal:** Same as Task 8: adopt `useVisibleReload`, `useLabelScanReview`, `<DetailRow>`, `<StatusBadge>`, `<ScanFab>`, and `<EmptyState>`. Remove duplicated `badgeClass` and scoped badge/detail styles.

- [ ] **Step 1: Update imports and script top**

Keep:

```ts
import { getShelfBoxDetail, markShelfBoxVerified, type ShelfBoxDetail } from "~/db/goodsVerify";
```

Replace `useLabelScan` with `useLabelScanReview`:

```ts
import { useLabelScanReview } from "~/composables/useLabelScanReview";
```

Define `onScanApplied` and `onRetake` as function declarations near the top of `<script setup>`:

```ts
async function onScanApplied() {
  await load();
  if (box.value && !box.value.verified && allVerified.value) {
    await markVerified();
  }
}

async function onRetake() {
  reviewOpen.value = false;
  await openScan();
}
```

Replace:

```ts
const { scan, scanning } = useLabelScan();
const reviewOpen = ref(false);
const review = ref<LabelScanResult | null>(null);
```

with:

```ts
const {
  scan,
  scanning,
  review,
  reviewOpen,
  handleResult,
  onApplied,
} = useLabelScanReview({ onApplied: onScanApplied });
```

- [ ] **Step 2: Replace lifecycle wiring**

Remove `onMounted`/`onUnmounted`/`onVisible` and add:

```ts
useVisibleReload(load);
```

- [ ] **Step 3: Replace `openScan` scan-result handling**

```ts
async function openScan() {
  if (!box.value) return;
  const result = await scan({ task: "goods-verify", items: box.value.items });
  if (result.status === "error") {
    error.value = result.message;
  } else if (result.status === "cancelled") {
    // silently ignore
  } else {
    await handleResult(result);
  }
}
```

Remove the old page-level `onScanApplied` definition (the hoisted definition above replaces it).

- [ ] **Step 4: Replace template blocks**

Use `<EmptyState>`, `<ScanFab>`, `<StatusBadge>`, and `<DetailRow>` as in Task 8.

`DetailHeader` currently uses `:badge-class="badgeClass(box.status)"`. Change to:

```vue
:badge-class="useStatusBadge().badgeClass(box.status)"
```

Prefer replacing the local function with `const { badgeClass } = useStatusBadge();` and keeping the existing `:badge-class="badgeClass(box.status)"` prop usage. The local `badgeClass` can be removed entirely once the scoped badge styles are removed in Task 23.

- [ ] **Step 5: Remove scoped styles**

Remove only the inline floating scan button styles. Keep `.detail-row`, `.detail-label`, `.badge--pending`, `.badge--in-hand`, `.badge--finished`, and `.card--done`; they are removed globally in Task 23.

- [ ] **Step 6: Verify**

Run: `pnpm nuxt prepare && pnpm generate`
Expected: build succeeds.

- [ ] **Step 7: Commit**

```bash
git add pages/goods-verify/box/[id].vue
git commit -m "refactor: adopt shared primitives in goods-verify box page"
```

---

## Phase 2 — Split the receiving detail page

### Task 10: Create `components/receiving/ReceivingItemsTab.vue`

**Files:**
- Create: `components/receiving/ReceivingItemsTab.vue`

**Goal:** Move the entire `view === 'receiving'` block from `pages/receiving/[id].vue` into this component.

Props:

```ts
interface Props {
  order: DisplayReceivingOrder;
  allocatedByItem: Record<string, number>;
  saving: Record<string, boolean>;
}
```

Emits:

```ts
const emit = defineEmits<{
  "report-issue": [item: DisplayReceivingItem];
}>();
```

- [ ] **Step 1: Write the component**

```vue
<template>
  <h2 class="section-title">Invoices & Items</h2>
  <div v-for="invoice in order.invoices" :key="invoice.id" style="margin-bottom: 1.5rem;">
    <h3 style="margin-bottom: 0.5rem; color: var(--muted);">
      Invoice {{ invoice.invoiceNo }}
    </h3>

    <div
      v-for="item in invoice.items"
      :key="item.id"
      class="card"
      :class="{ 'card--mismatch': item.reportedMismatch }"
    >
      <DetailRow label="Part" :value="item.part?.partNo" />
      <DetailRow label="PO / Line" :value="`${item.poNo} / ${item.poLine}`" />
      <DetailRow label="Expected" :value="item.qty" />
      <DetailRow label="Reserved" :value="allocatedByItem[item.id] || 0" />
      <DetailRow label="Picked" :value="item.pickedQty" />
      <DetailRow label="Put away" :value="item.putAwayQty" />
      <DetailRow
        label="Available"
        :value="item.receivedQty - item.pickedQty - item.putAwayQty - (allocatedByItem[item.id] || 0)"
      />
      <DetailRow
        label="Date / Lot / COO / COW"
        :value="`${item.dateCode} / ${item.lotCode} / ${item.coo} / ${item.cow}`"
      />

      <div v-if="order.status === 'pending' || order.status === 'in_hand'" style="margin-top: 0.75rem;">
        <template v-if="item.pickedQty > 0 || item.putAwayQty > 0">
          <p class="mismatch-locked">Locked: stock already in use.</p>
        </template>

        <template v-else-if="item.reportedMismatch">
          <div class="mismatch-summary">
            <span class="mismatch-badge">{{ formatMismatchSummary(item) }}</span>
            <span v-if="item.mismatchNote" class="mismatch-note">{{ item.mismatchNote }}</span>
            <button class="btn btn--small btn--danger" :disabled="saving[item.id]" @click="emit('report-issue', item)">Edit issue</button>
          </div>
        </template>

        <template v-else>
          <button class="btn btn--small btn--danger" :disabled="saving[item.id]" @click="emit('report-issue', item)">Report issue</button>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import * as schema from "~/db/schema";

type DisplayReceivingItem = typeof schema.receivingInvoiceItems.$inferSelect;

interface DisplayReceivingOrder {
  id: string;
  refNo: string;
  status: string;
  supplier?: typeof schema.suppliers.$inferSelect | null;
  deliveryDate: Date | null;
  invoices: Array<
    Omit<typeof schema.receivingInvoices.$inferSelect, "receivingOrderId"> & {
      items: DisplayReceivingItem[];
    }
  >;
}

const props = defineProps<{
  order: DisplayReceivingOrder;
  allocatedByItem: Record<string, number>;
  saving: Record<string, boolean>;
}>();

const emit = defineEmits<{
  "report-issue": [item: DisplayReceivingItem];
}>();

function formatMismatchSummary(item: DisplayReceivingItem): string {
  switch (item.mismatchReason) {
    case "not_found":
      return "Not found";
    case "damaged":
      return `Damaged: ${item.mismatchQty} of ${item.qty}`;
    case "quality_rejection":
      return `Quality rejection: ${item.mismatchQty} of ${item.qty}`;
    case "qty_mismatch":
      return `Quantity mismatch: received ${item.mismatchQty} of ${item.qty}`;
    case "over_shipment":
      return `Over shipment: +${item.mismatchQty}`;
    case "wrong_part":
      return `Wrong part: ${item.wrongPartNo} × ${item.mismatchQty}`;
    default:
      return "Mismatch reported";
  }
}
</script>

<style scoped>
.card--mismatch {
  border-left: 4px solid var(--danger);
}

.mismatch-badge {
  display: inline-block;
  padding: 0.25rem 0.625rem;
  font-size: 0.75rem;
  font-weight: 600;
  border-radius: 9999px;
  background: var(--danger-soft);
  color: var(--danger);
}

.mismatch-summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
}

.mismatch-note {
  font-size: 0.875rem;
  color: var(--muted);
  flex: 1;
}

.mismatch-locked {
  font-size: 0.875rem;
  color: var(--danger);
  margin: 0;
}
</style>
```

- [ ] **Step 2: Verify with `pnpm nuxt prepare`**

Run: `pnpm nuxt prepare`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add components/receiving/ReceivingItemsTab.vue
git commit -m "feat: add ReceivingItemsTab component"
```

### Task 11: Create `components/receiving/ReceivingPickingTab.vue`

**Files:**
- Create: `components/receiving/ReceivingPickingTab.vue`

**Goal:** Move the entire `view === 'picking'` block from `pages/receiving/[id].vue` into this component.

Props:

```ts
interface Props {
  order: DisplayReceivingOrder;
  groupedPickingOrders: GroupedOrder[];
  filteredGroupedPickingOrders: GroupedOrder[];
  boxesByOrder: Record<string, schema.shippingBoxes[]>;
  packagesByItem: Record<string, schema.pickingPackages[]>;
  transitionLogs: Record<string, any[]>;
  boxSelections: Record<string, string>;
  creatingBox: Record<string, boolean>;
  addingPackage: Record<string, boolean>;
  removingPackage: Record<string, boolean>;
  scanning: boolean;
  expandedItems: Set<string>;
  searchQuery: string;
}
```

Emits:

```ts
const emit = defineEmits<{
  "update:searchQuery": [value: string];
  "update:expandedItems": [value: Set<string>];
  "update:boxSelections": [value: Record<string, string>];
  "create-box": [pickingOrderId: string];
  "add-to-box": [packageId: string];
  "remove-from-box": [packageId: string];
  scan: [pickingItemId?: string];
}>();
```

- [ ] **Step 1: Write the component**

Move the picking tab template and the helper functions `openBoxesForOrder` and `boxById` into the component. Keep the local computed/utility logic that is only used by this tab.

Key template outline:

```vue
<template>
  <h2 class="section-title">Picking view</h2>
  <input
    :value="searchQuery"
    type="text"
    placeholder="Search picking orders or parts…"
    style="width: 100%; margin-bottom: 1rem;"
    @input="emit('update:searchQuery', ($event.target as HTMLInputElement).value)"
  />
  <p v-if="filteredGroupedPickingOrders.length === 0" class="empty">
    No picking orders are linked to this receiving order yet.
  </p>

  <div v-for="po in filteredGroupedPickingOrders" :key="po.id" class="card" style="margin-bottom: 1.5rem;">
    <DetailRow label="Picking order">
      <NuxtLink :to="`/picking/${po.id}`" class="card__title">{{ po.ref_no }}</NuxtLink>
    </DetailRow>
    <DetailRow label="Status">
      <StatusBadge :status="po.status" />
    </DetailRow>

    <div v-if="po.status !== 'finished'" style="margin-top: 0.75rem;">
      <button class="btn btn--small" :disabled="creatingBox[po.id]" @click="emit('create-box', po.id)">
        {{ creatingBox[po.id] ? "Creating…" : "Create box" }}
      </button>
    </div>

    <div v-if="(boxesByOrder[po.id] || []).length" style="margin-top: 0.75rem;">
      <h3 style="margin: 0 0 0.5rem; font-size: 0.875rem; color: var(--muted);">Boxes</h3>
      <div
        v-for="box in boxesByOrder[po.id]"
        :key="box.id"
        class="lot"
        style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap;"
      >
        <span style="font-size: 0.875rem; font-weight: 600;">{{ box.id }}</span>
        <StatusBadge :status="box.status" />
      </div>
    </div>

    <div v-for="pi in po.items" :key="pi.id" class="lot" style="margin-top: 0.75rem;">
      <DetailRow label="Part" :value="pi.part_no" />
      <DetailRow label="Required / scanned / boxed" :value="`${pi.required_qty} / ${pi.scanned_qty} / ${pi.boxed_qty}`" />
      <DetailRow label="Status">
        <StatusBadge :status="pi.boxed_qty >= pi.required_qty ? 'finished' : 'picking'" />
      </DetailRow>
      <div v-if="pi.locations.filter(l => l.allocated_qty > 0).length" class="detail-row">
        <span class="detail-label">Allocated lots</span>
      </div>
      <ul v-if="pi.locations.filter(l => l.allocated_qty > 0).length" style="margin: 0; padding-left: 1.25rem; font-size: 0.875rem; color: var(--muted);">
        <li v-for="(loc, idx) in pi.locations.filter(l => l.allocated_qty > 0)" :key="idx">
          {{ loc.shelf_code || loc.box_id || "Receiving area" }}
          · {{ loc.date_code || "—" }} / {{ loc.lot_code || "—" }} / {{ loc.coo || "—" }} / {{ loc.cow || "—" }}
          · qty {{ loc.allocated_qty }}
        </li>
      </ul>

      <div v-if="packagesByItem[pi.id]?.length" style="margin-top: 0.75rem;">
        <h3 style="margin: 0 0 0.5rem; font-size: 0.875rem; color: var(--muted);">Packages</h3>
        <div
          v-for="pkg in packagesByItem[pi.id]"
          :key="pkg.id"
          class="lot"
          style="display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; justify-content: space-between;"
        >
          <div style="display: flex; flex-direction: column; gap: 0.25rem;">
            <span style="font-size: 0.875rem;">
              {{ pkg.qty }} pcs · {{ pkg.dateCode || "—" }} / {{ pkg.lotCode || "—" }} / {{ pkg.coo || "—" }} / {{ pkg.cow || "—" }}
            </span>
            <span style="font-size: 0.75rem; color: var(--muted);">
              <template v-if="pkg.shippingBoxId">In box {{ pkg.shippingBoxId }}</template>
              <template v-else>Unboxed</template>
            </span>
          </div>
          <div v-if="!pkg.shippingBoxId" style="display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;">
            <select
              :value="boxSelections[pkg.id]"
              :disabled="addingPackage[pkg.id]"
              style="min-width: 8rem;"
              @change="updateBoxSelection(pkg.id, ($event.target as HTMLSelectElement).value)"
            >
              <option value="">Select box</option>
              <option v-for="box in openBoxesForOrder(po.id)" :key="box.id" :value="box.id">{{ box.id }}</option>
            </select>
            <button
              class="btn btn--small"
              :disabled="addingPackage[pkg.id] || !boxSelections[pkg.id]"
              @click="emit('add-to-box', pkg.id)"
            >
              {{ addingPackage[pkg.id] ? "Adding…" : "Add to box" }}
            </button>
          </div>
          <button
            v-else-if="boxById(pkg.shippingBoxId)?.status === 'open'"
            class="btn btn--small"
            :disabled="removingPackage[pkg.id]"
            @click="emit('remove-from-box', pkg.id)"
          >
            {{ removingPackage[pkg.id] ? "Removing…" : "Remove from box" }}
          </button>
        </div>
      </div>

      <div style="margin-top: 0.5rem; display: flex; gap: 0.5rem; flex-wrap: wrap;">
        <button class="btn btn--small" :disabled="scanning" @click="emit('scan', pi.id)">Scan</button>
        <button class="btn btn--small" @click="toggleExpand(pi.id)">
          {{ expandedItems.has(pi.id) ? "Hide picking logs" : "Show picking logs" }}
          ({{ (transitionLogs[pi.id] || []).length }})
        </button>

        <div v-if="expandedItems.has(pi.id)" style="width: 100%; margin-top: 0.5rem;">
          <p v-if="!(transitionLogs[pi.id] || []).length" class="card__meta">No picking logs.</p>
          <ul v-else style="margin: 0; padding-left: 1.25rem; font-size: 0.875rem; color: var(--muted);">
            <li v-for="log in transitionLogs[pi.id]" :key="log.id" style="margin-bottom: 0.35rem;">
              {{ new Date(log.createdAt).toLocaleString() }}
              · {{ log.actorName || "System" }}
              · {{ log.fromState || "—" }} → {{ log.toState }}
              <span v-if="log.metadata">
                · {{ JSON.parse(log.metadata).qty ?? JSON.parse(log.metadata).note }}
              </span>
            </li>
          </ul>
        </div>
      </div>
    </div>
  </div>
</template>
```

Script helpers to include:

```ts
function openBoxesForOrder(pickingOrderId: string) {
  return (props.boxesByOrder[pickingOrderId] ?? []).filter((b) => b.status === "open");
}

function boxById(boxId: string | null | undefined) {
  if (!boxId) return undefined;
  for (const boxes of Object.values(props.boxesByOrder)) {
    const box = boxes.find((b) => b.id === boxId);
    if (box) return box;
  }
  return undefined;
}

function updateBoxSelection(packageId: string, value: string) {
  emit("update:boxSelections", { ...props.boxSelections, [packageId]: value });
}

function toggleExpand(itemId: string) {
  const next = new Set(props.expandedItems);
  if (next.has(itemId)) next.delete(itemId);
  else next.add(itemId);
  emit("update:expandedItems", next);
}
```

- [ ] **Step 2: Verify with `pnpm nuxt prepare`**

Run: `pnpm nuxt prepare`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add components/receiving/ReceivingPickingTab.vue
git commit -m "feat: add ReceivingPickingTab component"
```

### Task 12: Refactor `pages/receiving/[id].vue` to use the tab components

**Files:**
- Modify: `pages/receiving/[id].vue`

**Goal:** Reduce the page to route handling, top-level load orchestration, tab state, scan entry point, and mismatch modal wiring.

- [ ] **Step 1: Update imports**

Add:

```ts
import ReceivingItemsTab from "~/components/receiving/ReceivingItemsTab.vue";
import ReceivingPickingTab from "~/components/receiving/ReceivingPickingTab.vue";
import { useVisibleReload } from "~/composables/useVisibleReload";
import { useStatusBadge } from "~/composables/useStatusBadge";
import { useLabelScanReview } from "~/composables/useLabelScanReview";
```

Remove:

```ts
import { useLabelScan, createManualReview, type LabelScanResult } from "~/composables/useLabelScan";
```

- [ ] **Step 2: Replace scan-review state**

Replace:

```ts
const { scan, scanning } = useLabelScan();
const reviewOpen = ref(false);
const review = ref<LabelScanResult | null>(null);
```

with:

```ts
const { badgeClass } = useStatusBadge();
const { scan, scanning, review, reviewOpen, onApplied } = useLabelScanReview({
  onApplied: load,
});

async function onRetake() {
  reviewOpen.value = false;
  await openScan(scanPickingItemId.value);
}
```

- [ ] **Step 3: Replace lifecycle wiring**

Remove the existing `onMounted`/`onUnmounted`/`onVisible` block and add:

```ts
useVisibleReload(load);
```

- [ ] **Step 4: Simplify `openScan`**

```ts
async function openScan(itemId?: string) {
  scanPickingItemId.value = itemId;
  const result = await scan({
    task: "receiving",
    receivingOrderId: orderId,
    pickingItemId: itemId,
  });
  if (result.status === "error") {
    error.value = result.message;
  }
  // applied/review/manual are handled by useLabelScanReview.
}
```

Remove the old page-level `onApplied` function (it now comes from the composable). Keep `onRetake` as defined above.

- [ ] **Step 5: Replace tab templates**

Replace the `view === 'receiving'` block with:

```vue
<ReceivingItemsTab
  v-if="view === 'receiving'"
  :order="order"
  :allocated-by-item="allocatedByItem"
  :saving="saving"
  @report-issue="openReportIssue"
/>
```

Replace the `view === 'picking'` block with:

```vue
<ReceivingPickingTab
  v-else
  :order="order"
  :grouped-picking-orders="groupedPickingOrders"
  :filtered-grouped-picking-orders="filteredGroupedPickingOrders"
  :boxes-by-order="boxesByOrder"
  :packages-by-item="packagesByItem"
  :transition-logs="transitionLogs"
  v-model:search-query="searchQuery"
  v-model:expanded-items="expandedItems"
  v-model:box-selections="boxSelections"
  :creating-box="creatingBox"
  :adding-package="addingPackage"
  :removing-package="removingPackage"
  :scanning="scanning"
  @create-box="createBox"
  @add-to-box="addToBox"
  @remove-from-box="removeFromBox"
  @scan="openScan"
/>
```

- [ ] **Step 6: Replace scan FAB**

```vue
<ScanFab
  v-if="order.status === 'in_hand' && remainingItems > 0 && view === 'picking'"
  :loading="scanning"
  @click="openScan()"
/>
```

- [ ] **Step 7: Replace loading/error with EmptyState**

```vue
<EmptyState v-if="pending">Loading…</EmptyState>
<EmptyState v-else-if="error" error>Error: {{ error }}</EmptyState>
```

- [ ] **Step 8: Replace header detail rows**

Use `<DetailRow>` for Supplier, Delivery date, and Remaining items.

- [ ] **Step 9: Remove scoped styles**

Keep `.detail-row`, `.detail-label`, `.lot`, `.badge--pending`, `.badge--in-hand`, and `.badge--finished`; they are removed globally in Task 23. Keep `.view-tabs`, `.tab-badge`, `.card--mismatch`, and mismatch styles (defined in `ReceivingItemsTab`).

- [ ] **Step 10: Verify**

Run: `pnpm nuxt prepare && pnpm generate`
Expected: build succeeds and page is under ~250 lines.

- [ ] **Step 11: Commit**

```bash
git add pages/receiving/[id].vue components/receiving/ReceivingItemsTab.vue components/receiving/ReceivingPickingTab.vue
git commit -m "refactor: split receiving detail into tab components"
```

---

## Phase 3 — Split the picking detail page

### Task 13: Create `components/picking/PickingBoxesSection.vue`

**Files:**
- Create: `components/picking/PickingBoxesSection.vue`

**Goal:** Move the boxes section (collapsible header + box cards) out of `pages/picking/[id].vue`.

Props:

```ts
interface Props {
  boxes: any[];
  actionable: boolean;
  creatingBox: boolean;
  cancellingBox: Record<string, boolean>;
}
```

Emits:

```ts
const emit = defineEmits<{
  "create-box": [];
  "cancel-box": [boxId: string];
  "update:expanded": [value: boolean];
}>();
```

- [ ] **Step 1: Write the component**

Move the existing boxes section template and `boxTotalQty` helper into the component. Replace inline detail rows with `<DetailRow>` and inline status badges with `<StatusBadge>`.

- [ ] **Step 2: Verify with `pnpm nuxt prepare`**

Run: `pnpm nuxt prepare`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add components/picking/PickingBoxesSection.vue
git commit -m "feat: add PickingBoxesSection component"
```

### Task 14: Create `components/picking/PickingItemsSection.vue`

**Files:**
- Create: `components/picking/PickingItemsSection.vue`

**Goal:** Move the items section (item cards + allocations + packages + logs) out of `pages/picking/[id].vue`.

Props:

```ts
interface Props {
  items: any[];
  order: any;
  transitionLogs: Record<string, any[]>;
  expandedItems: Set<string>;
  boxSelections: Record<string, string>;
  adding: Record<string, boolean>;
  removing: Record<string, boolean>;
  scanning: boolean;
  openBoxes: any[];
}
```

Emits:

```ts
const emit = defineEmits<{
  "update:expandedItems": [value: Set<string>];
  "update:boxSelections": [value: Record<string, string>];
  scan: [allocation: any];
  "add-to-box": [packageId: string];
  "remove-from-box": [packageId: string];
}>();
```

- [ ] **Step 1: Write the component**

Move the existing items section template and the helper functions `scannedQty`, `unboxedPackages`, `boxedPackages`, and `toggleExpand` into the component. Use `<DetailRow>` and `<StatusBadge>`.

- [ ] **Step 2: Verify with `pnpm nuxt prepare`**

Run: `pnpm nuxt prepare`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add components/picking/PickingItemsSection.vue
git commit -m "feat: add PickingItemsSection component"
```

### Task 15: Refactor `pages/picking/[id].vue`

**Files:**
- Modify: `pages/picking/[id].vue`

**Goal:** Reduce the page to route, load, actions, and scan orchestration.

- [ ] **Step 1: Update imports**

Add:

```ts
import PickingBoxesSection from "~/components/picking/PickingBoxesSection.vue";
import PickingItemsSection from "~/components/picking/PickingItemsSection.vue";
import { useVisibleReload } from "~/composables/useVisibleReload";
import { useStatusBadge } from "~/composables/useStatusBadge";
import { useLabelScanReview } from "~/composables/useLabelScanReview";
```

Remove:

```ts
import { useLabelScan, createManualReview, type LabelScanResult } from "~/composables/useLabelScan";
```

- [ ] **Step 2: Replace scan-review state and lifecycle**

Replace `useLabelScan` usage with:

```ts
const { scan, scanning, review, reviewOpen, onApplied } = useLabelScanReview({ onApplied: load });

async function onRetake() {
  reviewOpen.value = false;
  await openScan(scanAllocation.value);
}
```

Remove `onMounted`/`onUnmounted`/`onVisible` and add:

```ts
useVisibleReload(load);
```

- [ ] **Step 3: Use `useStatusBadge` for `headerBadgeClass`**

Replace the computed `headerBadgeClass` with:

```ts
const { badgeClass } = useStatusBadge();
const headerBadgeClass = computed(() => badgeClass(order.value?.status));
```

- [ ] **Step 4: Replace issue reason label**

Keep `issueReasonLabel` in the page or move it to the component. For now, keep it in the page and pass the label string into a future `IssueSummary` component if extracted later. In this plan, leave the issue banner inline.

- [ ] **Step 5: Replace boxes and items sections**

```vue
<PickingBoxesSection
  :boxes="order.shippingBoxes"
  :actionable="order.status !== 'finished' && order.status !== 'issue'"
  :creating-box="creatingBox"
  :cancelling-box="cancellingBox"
  v-model:expanded="boxesExpanded"
  @create-box="createBox"
  @cancel-box="cancelBox"
/>

<PickingItemsSection
  :items="order.items"
  :order="order"
  :transition-logs="transitionLogs"
  v-model:expanded-items="expandedItems"
  v-model:box-selections="boxSelections"
  :adding="adding"
  :removing="removing"
  :scanning="scanning"
  :open-boxes="openBoxes"
  @scan="openScan"
  @add-to-box="addToBox"
  @remove-from-box="removeFromBox"
/>
```

- [ ] **Step 6: Replace loading/error and scan FAB**

Use `<EmptyState>` and `<ScanFab>` as in Task 12.

- [ ] **Step 7: Remove scoped styles**

Keep `.detail-row`, `.detail-label`, `.lot`, `.card--done`, and `.card--danger`; they are removed globally in Task 23.

- [ ] **Step 8: Verify**

Run: `pnpm nuxt prepare && pnpm generate`
Expected: build succeeds and page is under ~250 lines.

- [ ] **Step 9: Commit**

```bash
git add pages/picking/[id].vue components/picking/PickingBoxesSection.vue components/picking/PickingItemsSection.vue
git commit -m "refactor: split picking detail into section components"
```

---

## Phase 4 — Split the put-away detail page

### Task 16: Create `components/put-away/ShelfBoxesPanel.vue`

**Files:**
- Create: `components/put-away/ShelfBoxesPanel.vue`

**Goal:** Move the shelf-boxes card (section header, create-box button, grouped box list, expand/collapse) out of `pages/put-away/[id].vue`.

Props:

```ts
interface Props {
  boxes: any[];
  boxesExpanded: boolean;
  actionable: boolean;
  creating: boolean;
  closing: boolean;
  cancellingBox: Record<string, boolean>;
  expandedItemBoxes: Set<string>;
}
```

Emits:

```ts
const emit = defineEmits<{
  "update:boxesExpanded": [value: boolean];
  "update:expandedItemBoxes": [value: Set<string>];
  "new-box": [];
  "close-box": [boxId: string];
  "cancel-box": [boxId: string];
}>();
```

- [ ] **Step 1: Write the component**

Move the shelf-boxes template and `boxTotalQty` helper into the component. Use `<DetailRow>` and `<StatusBadge>`.

- [ ] **Step 2: Verify with `pnpm nuxt prepare`**

Run: `pnpm nuxt prepare`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add components/put-away/ShelfBoxesPanel.vue
git commit -m "feat: add ShelfBoxesPanel component"
```

### Task 17: Create `components/put-away/PutAwayLotsPanel.vue`

**Files:**
- Create: `components/put-away/PutAwayLotsPanel.vue`

**Goal:** Move the available lots list and scan wiring out of `pages/put-away/[id].vue`.

Props:

```ts
interface Props {
  lots: PutAwayLot[];
  boxes: any[];
  targetBoxSelections: Record<string, string>;
  scanning: boolean;
}
```

Emits:

```ts
const emit = defineEmits<{
  "update:targetBoxSelections": [value: Record<string, string>];
  scan: [lot: PutAwayLot];
}>();
```

- [ ] **Step 1: Write the component**

Move the lots list template and `shelfLabel` helper into the component. Use `<DetailRow>`.

- [ ] **Step 2: Verify with `pnpm nuxt prepare`**

Run: `pnpm nuxt prepare`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add components/put-away/PutAwayLotsPanel.vue
git commit -m "feat: add PutAwayLotsPanel component"
```

### Task 18: Refactor `pages/put-away/[id].vue`

**Files:**
- Modify: `pages/put-away/[id].vue`

**Goal:** Reduce the page to route handling, `load()`, and action orchestration.

- [ ] **Step 1: Update imports**

Add:

```ts
import ShelfBoxesPanel from "~/components/put-away/ShelfBoxesPanel.vue";
import PutAwayLotsPanel from "~/components/put-away/PutAwayLotsPanel.vue";
import { useVisibleReload } from "~/composables/useVisibleReload";
import { useStatusBadge } from "~/composables/useStatusBadge";
import { useLabelScanReview } from "~/composables/useLabelScanReview";
```

Remove:

```ts
import { useLabelScan, createManualReview, type LabelScanResult } from "~/composables/useLabelScan";
```

- [ ] **Step 2: Replace scan-review state and lifecycle**

Replace `useLabelScan` usage with:

```ts
const { scan, scanning, review, reviewOpen, onApplied } = useLabelScanReview({ onApplied: load });

async function onRetake() {
  reviewOpen.value = false;
  await openScan(scanItem.value);
}
```

Remove `onMounted`/`onUnmounted`/`onVisible` and add:

```ts
useVisibleReload(load);
```

- [ ] **Step 3: Use `useStatusBadge`**

```ts
const { badgeClass } = useStatusBadge();
```

Keep passing `badgeClass(order.status)` to `DetailHeader`.

- [ ] **Step 4: Replace panels**

```vue
<ShelfBoxesPanel
  :boxes="boxes"
  v-model:boxes-expanded="boxesExpanded"
  :actionable="order.status !== 'finished' && order.status !== 'issue'"
  :creating="creating"
  :closing="closing"
  :cancelling-box="cancellingBox"
  v-model:expanded-item-boxes="expandedItemBoxes"
  @new-box="openNewBoxDialog"
  @close-box="closeBox"
  @cancel-box="cancelBox"
/>

<PutAwayLotsPanel
  :lots="lots"
  :boxes="boxes"
  v-model:target-box-selections="targetBoxSelections"
  :scanning="scanning"
  @scan="openScan"
/>
```

- [ ] **Step 5: Replace loading/error and scan FAB**

Use `<EmptyState>` and `<ScanFab>`.

- [ ] **Step 6: Remove scoped styles**

Keep `.detail-row`, `.detail-label`, `.lot`, `.badge--pending`, and `.badge--finished`; they are removed globally in Task 23.

- [ ] **Step 7: Verify**

Run: `pnpm nuxt prepare && pnpm generate`
Expected: build succeeds and page is under ~200 lines.

- [ ] **Step 8: Commit**

```bash
git add pages/put-away/[id].vue components/put-away/ShelfBoxesPanel.vue components/put-away/PutAwayLotsPanel.vue
git commit -m "refactor: split put-away detail into panel components"
```

---

## Phase 5 — Replace `badgeClass` in list/index pages

### Task 19: Update `pages/receiving/index.vue`

**Files:**
- Modify: `pages/receiving/index.vue`

- [ ] **Step 1: Replace local `badgeClass` with `useStatusBadge`**

Remove the local `badgeClass` function and add:

```ts
const { badgeClass } = useStatusBadge();
```

- [ ] **Step 2: Verify**

Run: `pnpm nuxt prepare`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add pages/receiving/index.vue
git commit -m "refactor: use shared useStatusBadge in receiving list"
```

### Task 20: Update `pages/put-away/index.vue`

**Files:**
- Modify: `pages/put-away/index.vue`

- [ ] **Step 1: Replace local `badgeClass` with `useStatusBadge`**

Same as Task 19.

- [ ] **Step 2: Verify and commit**

```bash
pnpm nuxt prepare
git add pages/put-away/index.vue
git commit -m "refactor: use shared useStatusBadge in put-away list"
```

### Task 21: Update `pages/picking/index.vue`

**Files:**
- Modify: `pages/picking/index.vue`

- [ ] **Step 1: Replace local `badgeClass` with `useStatusBadge`**

Same as Task 19.

- [ ] **Step 2: Verify and commit**

```bash
pnpm nuxt prepare
git add pages/picking/index.vue
git commit -m "refactor: use shared useStatusBadge in picking list"
```

### Task 22: Update `pages/goods-verify/shelf/[code].vue`

**Files:**
- Modify: `pages/goods-verify/shelf/[code].vue`

- [ ] **Step 1: Replace local `badgeClass` and scoped badge styles**

Remove the local `badgeClass` function and the scoped `.badge--pending`, `.badge--in-hand`, `.badge--finished` styles. Add:

```ts
const { badgeClass } = useStatusBadge();
```

- [ ] **Step 2: Verify and commit**

```bash
pnpm nuxt prepare
git add pages/goods-verify/shelf/[code].vue
git commit -m "refactor: use shared useStatusBadge in goods-verify shelf page"
```

---

## Phase 6 — Consolidate shared CSS

### Task 23: Move `.detail-row` / `.detail-label` to global CSS

**Files:**
- Modify: `assets/css/main.css`

- [ ] **Step 1: Append global utility styles**

Add at the end of `assets/css/main.css`:

```css
.detail-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  padding: 0.35rem 0;
  border-bottom: 1px solid var(--border);
}

.detail-row:last-child {
  border-bottom: none;
}

.detail-label {
  font-size: 0.8125rem;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.lot {
  background: var(--bg);
  border-radius: var(--radius);
  padding: 0.75rem;
}

.card--done {
  border-left: 4px solid #16a34a;
}

.card--danger {
  border-left: 4px solid var(--danger);
}
```

- [ ] **Step 2: Remove scoped copies from all detail pages**

Remove the following scoped style blocks from each page now that the global utilities exist:

- `pages/receiving/[id].vue`: `.detail-row`, `.detail-label`, `.lot`
- `pages/picking/[id].vue`: `.detail-row`, `.detail-label`, `.lot`, `.card--done`, `.card--danger`
- `pages/put-away/[id].vue`: `.detail-row`, `.detail-label`, `.lot`
- `pages/measuring/[taskId]/box/[boxId].vue`: `.detail-row`, `.detail-label`
- `pages/goods-verify/box/[id].vue`: `.detail-row`, `.detail-label`, `.card--done`
- `pages/goods-verify/shelf/[code].vue`: `.badge--pending`, `.badge--in-hand`, `.badge--finished` (already removed in Task 22)

Double-check with:

```bash
grep -n "\.detail-row {" pages/**/*.vue
```

Expected: no matches inside page files (the global copy in `main.css` is fine).

- [ ] **Step 3: Verify**

Run: `pnpm nuxt prepare && pnpm generate`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add assets/css/main.css
git commit -m "refactor: move detail-row, lot, and done/danger card modifiers to global CSS"
```

---

## Phase 7 — Verification

### Task 24: Static checks

- [ ] **Step 1: Type check**

Run: `pnpm nuxt prepare`
Expected: exits 0.

- [ ] **Step 2: Production build**

Run: `pnpm generate`
Expected: exits 0 and produces `.output/public`.

### Task 25: Manual browser verification

- [ ] **Step 1: Start dev server**

Run: `pnpm dev`

- [ ] **Step 2: Log in and exercise flows**

Log in as `operator` / `DocPal2026!` and verify on each affected page:

1. `pages/receiving/[id].vue`
   - Loading state renders.
   - Receiving tab shows invoices/items with detail rows.
   - Mismatch report button opens modal and saves.
   - Picking tab shows grouped picking orders, boxes, packages.
   - Create box, add to box, remove from box still work.
   - Scan FAB opens scan flow; review modal applies/retakes correctly.
   - Picking logs expand/collapse.

2. `pages/picking/[id].vue`
   - Header badge class correct for pending/finished/issue.
   - Boxes section collapses; create/cancel box work.
   - Items show allocations, unboxed/boxed packages, scan button.
   - Add/remove package to/from box works.
   - Picking logs expand/collapse.
   - Scan review modal works.

3. `pages/put-away/[id].vue`
   - Shelf boxes panel shows grouped boxes.
   - New box dialog opens and creates a box.
   - Close/cancel box work.
   - Available lots show; target box select + scan work.
   - Scan review modal works.

4. `pages/measuring/[taskId]/box/[boxId].vue`
   - Package list renders with verified/pending badges.
   - Scan FAB and per-package scan work.
   - All verified opens measurements modal.

5. `pages/goods-verify/box/[id].vue`
   - Expected items list renders.
   - Scan works; auto-mark-verified still triggers when all items verified.

### Task 26: Final commit

- [ ] **Step 1: Commit verification notes if any**

If any manual fixes were needed, commit them with a clear message. Otherwise, the work is already committed task-by-task.

---

## Self-review

1. **Spec coverage:** The original concern was "pages are too long". This plan addresses the five longest detail pages and the shared duplication that made them long. Receiving, picking, and put-away get page-specific components; measuring and goods-verify get shared-primitive cleanup.
2. **Placeholder scan:** No TBD/TODO placeholders remain. Each task includes file paths and concrete code.
3. **Type consistency:** `DisplayReceivingOrder` is defined in `ReceivingItemsTab` and `ReceivingPickingTab` with the same shape as the original page. `useStatusBadge().badgeClass` returns the same class names as the removed local functions. `useLabelScanReview` preserves the existing applied/review/manual/error behavior.

## Risks

- **Regression in scan workflows:** The scan-review modal wiring is the most sensitive logic. `useLabelScanReview` preserves the exact same state and event flow, but verify on Android after each page.
- **Prop drilling:** The receiving picking tab receives many props because the page still owns the data maps. If this feels noisy after implementation, consider moving the grouping/mapping logic into a composable in a follow-up.
- **Scoped style leakage:** Moving `.detail-row`, `.detail-label`, `.lot`, `.card--done`, and `.card--danger` to global CSS removes style isolation. Confirm no page relied on a subtly different definition.

## Out of scope / future ideas

- Converting the receiving-detail picking tab into a child route `/receiving/[id]/picking`.
- Extracting a generic `useAsyncDetail` wrapper for pending/error/data state.
- Unit tests for the new composables.

---

**Plan complete and saved to `docs/superpowers/plans/2026-07-03-page-component-separation.md`.**

Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using `executing-plans`, batch execution with checkpoints.

Which approach would you like?
