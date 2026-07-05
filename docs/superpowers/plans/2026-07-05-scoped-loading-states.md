# Scoped Loading States Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace full-page loading with scoped loading indicators on the buttons and rows that trigger actions.

**Architecture:** Add a small reusable `InlineSpinner` component. Use it inside buttons while their existing loading flags are true. Remove the full-page `LoadingOverlay` from receiving confirmation. Keep full-page `EmptyState` only for initial page load.

**Tech Stack:** Nuxt 3, Vue 3, plain CSS.

---

## File map

| File | Responsibility |
|------|----------------|
| `components/InlineSpinner.vue` (new) | Small inline spinner using `currentColor` so it works on any button. |
| `pages/receiving/[id].vue` | Remove full-page overlay; add spinner to Confirm arrived button. |
| `pages/picking/[id].vue` | Add spinner to Finish picking button. |
| `components/picking/PickingBoxesSection.vue` | Add spinner to Create box button. |
| `components/receiving/ReceivingItemsTab.vue` | Add spinners to Report issue / Save issue buttons. |
| `components/receiving/ReceivingPickingTab.vue` | Add spinners to Create box, Add to box, Remove from box buttons. |
| `components/picking/PickingItemsSection.vue` | Add spinners to Scan, Add to box, Remove from box buttons. |
| `components/LabelScanReviewModal.vue` | Add spinners to Apply and Find match buttons. |

---

## Task 1: Create InlineSpinner component

**Files:**
- Create: `components/InlineSpinner.vue`

- [ ] **Step 1: Write the component**

```vue
<template>
  <span class="spinner" aria-hidden="true" />
</template>

<style scoped>
.spinner {
  display: inline-block;
  width: 1em;
  height: 1em;
  border: 2px solid currentColor;
  border-bottom-color: transparent;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  vertical-align: middle;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
```

- [ ] **Step 2: Commit**

```bash
git add components/InlineSpinner.vue
git commit -m "feat(ui): add InlineSpinner component"
```

---

## Task 2: Receiving confirmation — remove overlay, scope spinner to Confirm button

**Files:**
- Modify: `pages/receiving/[id].vue`

- [ ] **Step 1: Remove the LoadingOverlay import and render block**

Delete this import:
```ts
import LoadingOverlay from "~/components/LoadingOverlay.vue";
```

Delete this block at the end of the top-level `<div>`:
```vue
<LoadingOverlay
  v-if="confirming"
  :label="$t('receiving.detail.confirmingArrival')"
/>
```

- [ ] **Step 2: Add spinner to the Confirm arrived button**

Find the button:
```vue
<button
  v-if="order.status === 'pending'"
  class="btn btn--small"
  :disabled="confirming"
  @click="confirmArrival"
>
  {{ confirming ? $t('actions.confirming') : $t('receiving.detail.confirmArrived') }}
</button>
```

Replace it with:
```vue
<button
  v-if="order.status === 'pending'"
  class="btn btn--small"
  :disabled="confirming"
  @click="confirmArrival"
>
  <template v-if="confirming">
    <InlineSpinner /> {{ $t('actions.confirming') }}
  </template>
  <template v-else>
    {{ $t('receiving.detail.confirmArrived') }}
  </template>
</button>
```

- [ ] **Step 3: Commit**

```bash
git add pages/receiving/[id].vue
git commit -m "feat(receiving): scope loading spinner to Confirm arrived button"
```

---

## Task 3: Picking Finish button spinner

**Files:**
- Modify: `pages/picking/[id].vue`

- [ ] **Step 1: Update the Finish picking button**

Find the button:
```vue
<button
  v-if="allItemsFullyBoxed"
  class="btn btn--small"
  :disabled="finishing"
  @click="finish"
>
  {{ finishing ? $t('actions.finishing') : $t('picking.detail.finishPicking') }}
</button>
```

Replace it with:
```vue
<button
  v-if="allItemsFullyBoxed"
  class="btn btn--small"
  :disabled="finishing"
  @click="finish"
>
  <template v-if="finishing">
    <InlineSpinner /> {{ $t('actions.finishing') }}
  </template>
  <template v-else>
    {{ $t('picking.detail.finishPicking') }}
  </template>
</button>
```

- [ ] **Step 2: Commit**

```bash
git add pages/picking/[id].vue
git commit -m "feat(picking): add spinner to Finish picking button"
```

---

## Task 4: Picking Create box button spinner

**Files:**
- Modify: `components/picking/PickingBoxesSection.vue`

- [ ] **Step 1: Update the Create box button**

Find the button:
```vue
<button
  v-if="actionable"
  class="btn btn--small"
  :disabled="creatingBox"
  @click="$emit('create-box')"
>
  {{ creatingBox ? $t('actions.creating') : $t('picking.boxesSection.newBox') }}
</button>
```

Replace it with:
```vue
<button
  v-if="actionable"
  class="btn btn--small"
  :disabled="creatingBox"
  @click="$emit('create-box')"
>
  <template v-if="creatingBox">
    <InlineSpinner /> {{ $t('actions.creating') }}
  </template>
  <template v-else>
    {{ $t('picking.boxesSection.newBox') }}
  </template>
</button>
```

- [ ] **Step 2: Commit**

```bash
git add components/picking/PickingBoxesSection.vue
git commit -m "feat(picking): add spinner to Create box button"
```

---

## Task 5: Receiving items tab — Report/Save issue button spinners

**Files:**
- Modify: `components/receiving/ReceivingItemsTab.vue`

- [ ] **Step 1: Update the Edit issue button**

Find:
```vue
<button class="btn btn--small btn--danger" :disabled="saving[item.id]" @click="emit('report-issue', item)">{{ $t('receiving.itemsTab.editIssue') }}</button>
```

Replace with:
```vue
<button class="btn btn--small btn--danger" :disabled="saving[item.id]" @click="emit('report-issue', item)">
  <template v-if="saving[item.id]">
    <InlineSpinner /> {{ $t('actions.saving') }}
  </template>
  <template v-else>
    {{ $t('receiving.itemsTab.editIssue') }}
  </template>
</button>
```

- [ ] **Step 2: Update the Report issue button**

Find:
```vue
<button class="btn btn--small btn--danger" :disabled="saving[item.id]" @click="emit('report-issue', item)">{{ $t('receiving.itemsTab.reportIssue') }}</button>
```

Replace with:
```vue
<button class="btn btn--small btn--danger" :disabled="saving[item.id]" @click="emit('report-issue', item)">
  <template v-if="saving[item.id]">
    <InlineSpinner /> {{ $t('actions.saving') }}
  </template>
  <template v-else>
    {{ $t('receiving.itemsTab.reportIssue') }}
  </template>
</button>
```

- [ ] **Step 3: Commit**

```bash
git add components/receiving/ReceivingItemsTab.vue
git commit -m "feat(receiving): add spinners to issue buttons"
```

---

## Task 6: Receiving picking tab — Create box, Add/Remove box button spinners

**Files:**
- Modify: `components/receiving/ReceivingPickingTab.vue`

- [ ] **Step 1: Update the Create box button**

Find:
```vue
<button class="btn btn--small" :disabled="creatingBox[po.id]" @click="emit('create-box', po.id)">
  {{ creatingBox[po.id] ? $t('receiving.pickingTab.creating') : $t('receiving.pickingTab.createBox') }}
</button>
```

Replace with:
```vue
<button class="btn btn--small" :disabled="creatingBox[po.id]" @click="emit('create-box', po.id)">
  <template v-if="creatingBox[po.id]">
    <InlineSpinner /> {{ $t('receiving.pickingTab.creating') }}
  </template>
  <template v-else>
    {{ $t('receiving.pickingTab.createBox') }}
  </template>
</button>
```

- [ ] **Step 2: Update the Add to box button**

Find:
```vue
<button
  class="btn btn--small"
  :disabled="addingPackage[pkg.id] || !boxSelections[pkg.id]"
  @click="emit('add-to-box', pkg.id)"
>
  {{ addingPackage[pkg.id] ? $t('receiving.pickingTab.adding') : $t('receiving.pickingTab.addToBox') }}
</button>
```

Replace with:
```vue
<button
  class="btn btn--small"
  :disabled="addingPackage[pkg.id] || !boxSelections[pkg.id]"
  @click="emit('add-to-box', pkg.id)"
>
  <template v-if="addingPackage[pkg.id]">
    <InlineSpinner /> {{ $t('receiving.pickingTab.adding') }}
  </template>
  <template v-else>
    {{ $t('receiving.pickingTab.addToBox') }}
  </template>
</button>
```

- [ ] **Step 3: Update the Remove from box button**

Find:
```vue
<button
  v-else-if="boxById(pkg.shippingBoxId)?.status === 'open'"
  class="btn btn--small"
  :disabled="removingPackage[pkg.id]"
  @click="emit('remove-from-box', pkg.id)"
>
  {{ removingPackage[pkg.id] ? $t('receiving.pickingTab.removing') : $t('receiving.pickingTab.removeFromBox') }}
</button>
```

Replace with:
```vue
<button
  v-else-if="boxById(pkg.shippingBoxId)?.status === 'open'"
  class="btn btn--small"
  :disabled="removingPackage[pkg.id]"
  @click="emit('remove-from-box', pkg.id)"
>
  <template v-if="removingPackage[pkg.id]">
    <InlineSpinner /> {{ $t('receiving.pickingTab.removing') }}
  </template>
  <template v-else>
    {{ $t('receiving.pickingTab.removeFromBox') }}
  </template>
</button>
```

- [ ] **Step 4: Commit**

```bash
git add components/receiving/ReceivingPickingTab.vue
git commit -m "feat(receiving): add spinners to picking tab action buttons"
```

---

## Task 7: Picking items section — Scan, Add/Remove box button spinners

**Files:**
- Modify: `components/picking/PickingItemsSection.vue`

- [ ] **Step 1: Update the Scan buttons**

Find both occurrences of:
```vue
<button class="btn btn--small" :disabled="scanning" @click="emit('scan', allocation)">{{ $t('picking.itemsSection.scan') }}</button>
```

Replace both with:
```vue
<button class="btn btn--small" :disabled="scanning" @click="emit('scan', allocation)">
  <template v-if="scanning">
    <InlineSpinner /> {{ $t('picking.itemsSection.scan') }}
  </template>
  <template v-else>
    {{ $t('picking.itemsSection.scan') }}
  </template>
</button>
```

- [ ] **Step 2: Update the Add to box button**

Find:
```vue
<button
  class="btn btn--small"
  :disabled="adding[pkg.id] || !boxSelections[pkg.id]"
  @click="emit('add-to-box', pkg.id)"
>
  {{ adding[pkg.id] ? $t('picking.itemsSection.adding') : $t('picking.itemsSection.addToBox') }}
</button>
```

Replace with:
```vue
<button
  class="btn btn--small"
  :disabled="adding[pkg.id] || !boxSelections[pkg.id]"
  @click="emit('add-to-box', pkg.id)"
>
  <template v-if="adding[pkg.id]">
    <InlineSpinner /> {{ $t('picking.itemsSection.adding') }}
  </template>
  <template v-else>
    {{ $t('picking.itemsSection.addToBox') }}
  </template>
</button>
```

- [ ] **Step 3: Update the Remove button**

Find:
```vue
<button
  v-if="openBoxById[pkg.shippingBoxId!]?.status === 'open'"
  class="btn btn--small"
  :disabled="removing[pkg.id]"
  @click="emit('remove-from-box', pkg.id)"
>
  {{ removing[pkg.id] ? $t('picking.itemsSection.removing') : $t('picking.itemsSection.remove') }}
</button>
```

Replace with:
```vue
<button
  v-if="openBoxById[pkg.shippingBoxId!]?.status === 'open'"
  class="btn btn--small"
  :disabled="removing[pkg.id]"
  @click="emit('remove-from-box', pkg.id)"
>
  <template v-if="removing[pkg.id]">
    <InlineSpinner /> {{ $t('picking.itemsSection.removing') }}
  </template>
  <template v-else>
    {{ $t('picking.itemsSection.remove') }}
  </template>
</button>
```

- [ ] **Step 4: Commit**

```bash
git add components/picking/PickingItemsSection.vue
git commit -m "feat(picking): add spinners to item action buttons"
```

---

## Task 8: Label scan review modal — Apply and Find match button spinners

**Files:**
- Modify: `components/LabelScanReviewModal.vue`

- [ ] **Step 1: Update the Apply button**

Find:
```vue
<button
  type="button"
  class="btn btn--full"
  :disabled="applying"
  @click="applyRecord(localMatchResult.apply)"
>
  {{ applying ? $t('labelScanReviewModal.applying') : $t('labelScanReviewModal.apply') }}
</button>
```

Replace with:
```vue
<button
  type="button"
  class="btn btn--full"
  :disabled="applying"
  @click="applyRecord(localMatchResult.apply)"
>
  <template v-if="applying">
    <InlineSpinner /> {{ $t('labelScanReviewModal.applying') }}
  </template>
  <template v-else>
    {{ $t('labelScanReviewModal.apply') }}
  </template>
</button>
```

- [ ] **Step 2: Update the multiple-match option buttons**

Find:
```vue
<button
  v-for="(record, index) in localMatchResult.records"
  :key="index"
  type="button"
  class="option"
  :disabled="applying || matching"
  @click="applyRecord(record.apply)"
>
  <div class="letter">📦</div>
  <div class="content">
    <h3>{{ $t('labelScanReviewModal.matchN', { n: index + 1 }) }}</h3>
    <p>{{ formatRecord(record.record) }}</p>
  </div>
</button>
```

Replace with:
```vue
<button
  v-for="(record, index) in localMatchResult.records"
  :key="index"
  type="button"
  class="option"
  :disabled="applying || matching"
  @click="applyRecord(record.apply)"
>
  <div class="letter">
    <template v-if="applying"><InlineSpinner /></template>
    <template v-else>📦</template>
  </div>
  <div class="content">
    <h3>{{ $t('labelScanReviewModal.matchN', { n: index + 1 }) }}</h3>
    <p>{{ formatRecord(record.record) }}</p>
  </div>
</button>
```

- [ ] **Step 3: Update the Find match button**

Find:
```vue
<button type="button" class="btn" :disabled="applying || matching" @click="findMatch">
  {{ matching ? $t('labelScanReviewModal.matching') : $t('labelScanReviewModal.findMatch') }}
</button>
```

Replace with:
```vue
<button type="button" class="btn" :disabled="applying || matching" @click="findMatch">
  <template v-if="matching">
    <InlineSpinner /> {{ $t('labelScanReviewModal.matching') }}
  </template>
  <template v-else>
    {{ $t('labelScanReviewModal.findMatch') }}
  </template>
</button>
```

- [ ] **Step 4: Commit**

```bash
git add components/LabelScanReviewModal.vue
git commit -m "feat(scan): add spinners to apply and find-match buttons"
```

---

## Task 9: Verify types, tests, and build

- [ ] **Step 1: Generate Nuxt types**

```bash
export PATH="/c/Program Files/nodejs:$PATH" && pnpm nuxt prepare
```

Expected: command exits with code 0 and no TypeScript errors.

- [ ] **Step 2: Run the test suite**

```bash
export PATH="/c/Program Files/nodejs:$PATH" && pnpm test
```

Expected: all existing tests pass.

- [ ] **Step 3: Build the project**

```bash
export PATH="/c/Program Files/nodejs:$PATH" && pnpm generate
```

Expected: static export completes without errors.

- [ ] **Step 4: Commit any generated type updates**

```bash
git add -A
git commit -m "chore: regenerate types after scoped loading changes"
```

If no tracked files changed, skip the commit and note it.

---

## Self-review

### Spec coverage

- Full-page loading only for initial load → Tasks 2 removes receiving overlay; other detail pages already use `pending` only for initial load.
- Button-level loading for primary actions → Tasks 2, 3, 4.
- Row/item-level loading for per-item actions → Tasks 5, 6, 7, 8.

### Placeholder scan

- No TBD/TODO, no vague steps, every code block is complete.

### Type consistency

- `InlineSpinner` is auto-imported by Nuxt in all consuming files.
- All loading flags referenced in tasks already exist in the parent components.
