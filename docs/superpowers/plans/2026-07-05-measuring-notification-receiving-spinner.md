# Measuring Notification & Receiving Spinner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a toast notification when a picking order finishes and creates a measuring task, and add a loading spinner overlay while confirming a receiving order.

**Architecture:** A shared `useToast` composable with module-level reactive state drives a `ToastHost` component mounted in the default layout. The picking detail page pushes a toast after a successful finish. A reusable `LoadingOverlay` component is rendered by the receiving detail page while its existing `confirming` flag is true.

**Tech Stack:** Nuxt 3, Vue 3, plain CSS, PGlite/Drizzle, Vitest.

---

## File map

| File | Responsibility |
|------|----------------|
| `composables/useToast.ts` | Global reactive toast store: `showToast`, `dismissToast`, `toasts`. |
| `components/ToastHost.vue` | Renders toasts at the bottom-center of the viewport. |
| `layouts/default.vue` | Mounts `ToastHost` once for all pages. |
| `pages/picking/[id].vue` | Calls `showToast` after `finishPickingOrder` succeeds. |
| `components/LoadingOverlay.vue` | Full-viewport centered spinner with a label. |
| `pages/receiving/[id].vue` | Renders `LoadingOverlay` while `confirming.value` is true. |
| `i18n/locales/*.ts` | New translation keys for toast and loading text. |

---

## Task 1: Create the global toast store

**Files:**
- Create: `composables/useToast.ts`

- [ ] **Step 1: Write the composable**

```ts
import { readonly, ref } from "vue";

export interface Toast {
  id: string;
  message: string;
  action?: { label: string; to: string };
}

const toasts = ref<Toast[]>([]);
let idCounter = 0;

const DEFAULT_DURATION_MS = 3000;

export function useToast() {
  function showToast(message: string, options?: { action?: { label: string; to: string } }) {
    const id = `toast-${++idCounter}-${Date.now()}`;
    toasts.value.push({ id, message, action: options?.action });
    setTimeout(() => dismissToast(id), DEFAULT_DURATION_MS);
  }

  function dismissToast(id: string) {
    const index = toasts.value.findIndex((t) => t.id === id);
    if (index !== -1) toasts.value.splice(index, 1);
  }

  return {
    toasts: readonly(toasts),
    showToast,
    dismissToast,
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add composables/useToast.ts
git commit -m "feat(toast): add global useToast composable"
```

---

## Task 2: Create the ToastHost component

**Files:**
- Create: `components/ToastHost.vue`

- [ ] **Step 1: Write the component**

```vue
<template>
  <Teleport to="body">
    <div class="toast-host">
      <TransitionGroup name="toast" tag="div" class="toast-list">
        <div
          v-for="toast in toasts"
          :key="toast.id"
          class="toast"
          role="status"
          aria-live="polite"
        >
          <span class="toast__message">{{ toast.message }}</span>
          <NuxtLink
            v-if="toast.action"
            :to="toast.action.to"
            class="toast__action"
            @click="dismissToast(toast.id)"
          >
            {{ toast.action.label }}
          </NuxtLink>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { useToast } from "~/composables/useToast";

const { toasts, dismissToast } = useToast();
</script>

<style scoped>
.toast-host {
  position: fixed;
  bottom: 1rem;
  left: 50%;
  transform: translateX(-50%);
  z-index: 1000;
  pointer-events: none;
}

.toast-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.toast {
  pointer-events: auto;
  min-width: 16rem;
  max-width: calc(100vw - 2rem);
  padding: 0.75rem 1rem;
  background: var(--surface);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.toast__action {
  margin-left: auto;
  color: var(--primary);
  font-weight: 600;
  white-space: nowrap;
}

.toast-enter-active,
.toast-leave-active {
  transition: all 0.2s ease;
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(1rem);
}
</style>
```

- [ ] **Step 2: Commit**

```bash
git add components/ToastHost.vue
git commit -m "feat(toast): add ToastHost presentation component"
```

---

## Task 3: Mount ToastHost in the default layout

**Files:**
- Modify: `layouts/default.vue`

- [ ] **Step 1: Add the component inside the app wrapper**

Replace:
```vue
<template>
  <div class="app">
    <AppHeader />
    <main :class="['container', { 'no-padding': $route?.meta?.props?.noPadding }]">
      <slot />
    </main>
  </div>
</template>
```

With:
```vue
<template>
  <div class="app">
    <AppHeader />
    <main :class="['container', { 'no-padding': $route?.meta?.props?.noPadding }]">
      <slot />
    </main>
    <ToastHost />
  </div>
</template>
```

Do not add or remove the `<script>` block; only add the `<ToastHost />` element before the closing `</div>`.

- [ ] **Step 2: Commit**

```bash
git add layouts/default.vue
git commit -m "feat(toast): render ToastHost in default layout"
```

---

## Task 4: Add i18n keys for the measuring toast

**Files:**
- Modify: `i18n/locales/en-US.ts`
- Modify: `i18n/locales/zh-HK.ts`
- Modify: `i18n/locales/zh-CN.ts`

- [ ] **Step 1: Add English keys under `picking.detail`**

In `i18n/locales/en-US.ts`, inside `picking.detail`, add:

```ts
measuringTaskCreated: "Measuring task created",
goToMeasuring: "Go to measuring",
```

So the block becomes:
```ts
detail: {
  title: "Picking Detail",
  supplier: "Supplier",
  deliveryDate: "Delivery date",
  poNo: "PO No.",
  shipTo: "Ship to",
  dateCodeNotice: "Date-code notice",
  finishPicking: "Finish picking",
  measuring: "Measuring",
  measuringTaskCreated: "Measuring task created",
  goToMeasuring: "Go to measuring",
},
```

- [ ] **Step 2: Add Traditional Chinese keys**

In `i18n/locales/zh-HK.ts`, inside `picking.detail`, add:

```ts
measuringTaskCreated: "測量任務已建立",
goToMeasuring: "前往測量",
```

- [ ] **Step 3: Add Simplified Chinese keys**

In `i18n/locales/zh-CN.ts`, inside `picking.detail`, add:

```ts
measuringTaskCreated: "测量任务已创建",
goToMeasuring: "前往测量",
```

- [ ] **Step 4: Commit**

```bash
git add i18n/locales/en-US.ts i18n/locales/zh-HK.ts i18n/locales/zh-CN.ts
git commit -m "i18n: add measuring task created toast strings"
```

---

## Task 5: Show the toast after finishing a picking order

**Files:**
- Modify: `pages/picking/[id].vue`

- [ ] **Step 1: Import useToast**

Add the import near the top of the `<script setup>` block:

```ts
import { useToast } from "~/composables/useToast";
```

- [ ] **Step 2: Initialize the composable**

After the existing composable calls, add:

```ts
const { showToast } = useToast();
```

- [ ] **Step 3: Update the finish handler**

Replace the existing `finish` function:

```ts
async function finish() {
  finishing.value = true;
  try {
    await finishPickingOrder(db, orderId, currentUserId());
    await load();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    finishing.value = false;
  }
}
```

With:

```ts
async function finish() {
  finishing.value = true;
  try {
    await finishPickingOrder(db, orderId, currentUserId());
    await load();
    if (order.value?.measuringTask) {
      showToast(t("picking.detail.measuringTaskCreated"), {
        action: {
          label: t("picking.detail.goToMeasuring"),
          to: `/measuring/${order.value.measuringTask.id}`,
        },
      });
    }
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    finishing.value = false;
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add pages/picking/[id].vue
git commit -m "feat(picking): show toast when measuring task is created"
```

---

## Task 6: Create the LoadingOverlay component

**Files:**
- Create: `components/LoadingOverlay.vue`

- [ ] **Step 1: Write the component**

```vue
<template>
  <div class="loading-overlay" role="status" aria-live="polite">
    <div class="loading-overlay__spinner" aria-hidden="true" />
    <p v-if="label" class="loading-overlay__label">{{ label }}</p>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  label?: string;
}>();
</script>

<style scoped>
.loading-overlay {
  position: fixed;
  inset: 0;
  z-index: 999;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1rem;
  background: rgba(255, 255, 255, 0.85);
  backdrop-filter: blur(2px);
}

.loading-overlay__spinner {
  width: 2.5rem;
  height: 2.5rem;
  border: 3px solid var(--border);
  border-top-color: var(--primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.loading-overlay__label {
  color: var(--muted);
  font-size: 0.9375rem;
  font-weight: 500;
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
git add components/LoadingOverlay.vue
git commit -m "feat(ui): add LoadingOverlay component"
```

---

## Task 7: Add i18n keys for the receiving confirmation spinner

**Files:**
- Modify: `i18n/locales/en-US.ts`
- Modify: `i18n/locales/zh-HK.ts`
- Modify: `i18n/locales/zh-CN.ts`

- [ ] **Step 1: Add English key**

In `i18n/locales/en-US.ts`, inside `receiving.detail`, add:

```ts
confirmingArrival: "Confirming arrival…",
```

So the block becomes:
```ts
detail: {
  title: "Receiving Detail",
  supplier: "Supplier",
  deliveryDate: "Delivery date",
  remainingItems: "Remaining items",
  tabReceiving: "Receiving",
  tabPicking: "Picking",
  confirmArrived: "Confirm arrived",
  confirmingArrival: "Confirming arrival…",
},
```

- [ ] **Step 2: Add Traditional Chinese key**

In `i18n/locales/zh-HK.ts`, inside `receiving.detail`, add:

```ts
confirmingArrival: "確認收貨中…",
```

- [ ] **Step 3: Add Simplified Chinese key**

In `i18n/locales/zh-CN.ts`, inside `receiving.detail`, add:

```ts
confirmingArrival: "确认收货中…",
```

- [ ] **Step 4: Commit**

```bash
git add i18n/locales/en-US.ts i18n/locales/zh-HK.ts i18n/locales/zh-CN.ts
git commit -m "i18n: add receiving confirmation spinner label"
```

---

## Task 8: Render LoadingOverlay during receiving confirmation

**Files:**
- Modify: `pages/receiving/[id].vue`

- [ ] **Step 1: Import the component**

Add the import near the top of the `<script setup>` imports:

```ts
import LoadingOverlay from "~/components/LoadingOverlay.vue";
```

- [ ] **Step 2: Add the overlay in the template**

Add the overlay inside the top-level `<div>` but after the closing `</template>` of the `v-else-if="order"` block (i.e. after `ReportIssueModal` and still before the final `</div>`):

```vue
<LoadingOverlay
  v-if="confirming"
  :label="$t('receiving.detail.confirmingArrival')"
/>
```

- [ ] **Step 3: Commit**

```bash
git add pages/receiving/[id].vue
git commit -m "feat(receiving): show loading overlay while confirming arrival"
```

---

## Task 9: Verify type generation and run checks

- [ ] **Step 1: Generate Nuxt types**

```bash
pnpm nuxt prepare
```

Expected: command exits with code 0 and no TypeScript errors.

- [ ] **Step 2: Run the test suite**

```bash
pnpm test
```

Expected: all existing tests pass.

- [ ] **Step 3: Build the project**

```bash
pnpm generate
```

Expected: static export completes without errors.

- [ ] **Step 4: Commit any generated type updates**

```bash
git add -A
git commit -m "chore: regenerate types after toast and overlay changes"
```

---

## Self-review

### Spec coverage

- Toast when measuring task is created → Tasks 1–5.
- Loading spinner during receiving confirmation → Tasks 6–8.

### Placeholder scan

- No TBD/TODO, no vague steps, every code block is complete.

### Type consistency

- `useToast` returns `readonly(toasts)` and `showToast`/`dismissToast`.
- `ToastHost` consumes the same names.
- `LoadingOverlay` accepts an optional `label` prop.
- i18n keys match usage in `pages/picking/[id].vue` and `pages/receiving/[id].vue`.
