# Boxes section redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the Boxes sections on picking and put-away detail pages to show count + New box action in a compact header, and add shelf grouping and per-box item visibility for put-away.

**Architecture:** Update the existing detail pages with a shared header pattern; introduce a small `SelectShelfDialog` component for put-away; compute shelf groups and per-box item visibility reactively.

**Tech Stack:** Nuxt 3, Vue 3, plain CSS.

---

## File map

| File | Change |
|------|--------|
| `components/SelectShelfDialog.vue` | New reusable shelf-selection dialog. |
| `pages/picking/[id].vue` | Redesign Boxes header: `Boxes(count)`, New box button, toggle. |
| `pages/put-away/[id].vue` | Redesign Shelf boxes header, use dialog for new box, group by shelf, toggle item visibility per box. |

---

### Task 1: Create `components/SelectShelfDialog.vue`

**Files:**
- Create: `components/SelectShelfDialog.vue`

- [ ] **Step 1: Write the component**

```vue
<template>
  <div
    v-if="modelValue"
    class="modal-overlay"
    role="dialog"
    aria-modal="true"
    aria-labelledby="shelf-title"
    @click.self="close"
    @keydown.esc="close"
  >
    <div class="modal">
      <div class="modal__header">
        <h3 id="shelf-title">Select shelf</h3>
        <button type="button" class="modal__close" aria-label="Close" @click="close">×</button>
      </div>

      <div class="modal__body">
        <label class="field">
          <span>Shelf</span>
          <select v-model="selectedShelf">
            <option value="">Select a shelf</option>
            <option v-for="shelf in shelves" :key="shelf.code" :value="shelf.code">
              {{ shelf.zone ? `${shelf.code} — ${shelf.zone}` : shelf.code }}
            </option>
          </select>
        </label>

        <div class="actions">
          <button type="button" class="btn btn--secondary" @click="close">Cancel</button>
          <button type="button" class="btn" :disabled="!selectedShelf" @click="confirm">
            Confirm
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
interface Shelf {
  code: string;
  zone: string | null;
}

const props = defineProps<{
  modelValue: boolean;
  shelves: Shelf[];
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: boolean): void;
  (e: "selected", shelfCode: string): void;
}>();

const selectedShelf = ref("");

watch(
  () => props.modelValue,
  (open) => {
    if (open) selectedShelf.value = "";
  },
  { immediate: true }
);

function close() {
  emit("update:modelValue", false);
}

function confirm() {
  if (!selectedShelf.value) return;
  emit("selected", selectedShelf.value);
  close();
}
</script>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  z-index: 100;
}

.modal {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  width: 100%;
  max-width: 360px;
}

.modal__header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1rem;
  border-bottom: 1px solid var(--border);
}

.modal__header h3 {
  margin: 0;
  font-size: 1.0625rem;
}

.modal__close {
  background: transparent;
  border: none;
  font-size: 1.5rem;
  line-height: 1;
  color: var(--muted);
  cursor: pointer;
}

.modal__body {
  padding: 1rem;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  margin-bottom: 1rem;
}

.field > span {
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--muted);
  text-transform: uppercase;
}

.field select {
  width: 100%;
  padding: 0.625rem 0.875rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-size: 1rem;
  background: var(--surface);
}

.actions {
  display: flex;
  gap: 0.5rem;
}

.actions .btn {
  flex: 1;
}

.btn {
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--primary);
  border-radius: var(--radius);
  background: var(--primary);
  color: #fff;
  font-size: 0.9375rem;
  font-weight: 600;
  cursor: pointer;
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn--secondary {
  background: var(--surface);
  color: var(--text);
  border-color: var(--border);
}
</style>
```

- [ ] **Step 2: Generate types**

Run: `pnpm nuxt prepare`

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add components/SelectShelfDialog.vue
git commit -m "feat: add SelectShelfDialog component"
```

---

### Task 2: Redesign picking Boxes header

**Files:**
- Modify: `pages/picking/[id].vue`

- [ ] **Step 1: Replace the Boxes header and remove the inner Create box button**

Replace:

```vue
      <div class="section-title" style="display: flex; justify-content: space-between; align-items: center;">
        <h2 style="margin: 0;">Boxes</h2>
        <button
          class="btn btn--small btn--ghost"
          :aria-expanded="boxesExpanded"
          @click="boxesExpanded = !boxesExpanded"
        >
          {{ boxesExpanded ? "Hide" : `Show ${order.shippingBoxes?.length ?? 0}` }}
        </button>
      </div>

      <div v-if="boxesExpanded" style="margin-bottom: 1.5rem;">
        <button
          v-if="order.status !== 'finished' && order.status !== 'issue'"
          class="btn btn--small"
          style="margin-bottom: 1rem;"
          :disabled="creatingBox"
          @click="createBox"
        >
          {{ creatingBox ? "Creating…" : "Create box" }}
        </button>

        <p v-if="!order.shippingBoxes?.length" class="empty">No boxes yet.</p>
```

With:

```vue
      <div class="section-title" style="display: flex; justify-content: space-between; align-items: center;">
        <h2 style="margin: 0;">Boxes({{ order.shippingBoxes?.length ?? 0 }})</h2>
        <div style="display: flex; gap: 0.5rem; align-items: center;">
          <button
            v-if="order.status !== 'finished' && order.status !== 'issue'"
            class="btn btn--small"
            :disabled="creatingBox"
            @click="createBox"
          >
            {{ creatingBox ? "Creating…" : "New box" }}
          </button>
          <button
            class="btn btn--small btn--ghost"
            :aria-expanded="boxesExpanded"
            @click="boxesExpanded = !boxesExpanded"
          >
            {{ boxesExpanded ? "Hide" : "Show" }}
          </button>
        </div>
      </div>

      <div v-if="boxesExpanded" style="margin-bottom: 1.5rem;">
        <p v-if="!order.shippingBoxes?.length" class="empty">No boxes yet.</p>
```

- [ ] **Step 2: Generate types**

Run: `pnpm nuxt prepare`

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add pages/picking/[id].vue
git commit -m "ui(picking): redesign boxes header with count and new box action"
```

---

### Task 3: Redesign put-away Shelf boxes section

**Files:**
- Modify: `pages/put-away/[id].vue`

- [ ] **Step 1: Import the dialog component**

After:

```typescript
import LabelScanReviewModal from "~/components/LabelScanReviewModal.vue";
```

Add:

```typescript
import SelectShelfDialog from "~/components/SelectShelfDialog.vue";
```

- [ ] **Step 2: Add state for dialog and per-box item visibility**

After:

```typescript
const boxesExpanded = ref(false);
```

Add:

```typescript
const newBoxDialogOpen = ref(false);
const expandedItemBoxes = ref<Set<string>>(new Set());
```

- [ ] **Step 3: Add computed grouping and watch for default item visibility**

After:

```typescript
const openBoxes = computed(() => boxes.value.filter((b) => b.status === "open"));
const hasOpenBox = computed(() => openBoxes.value.length > 0);
```

Add:

```typescript
const boxesByShelf = computed(() => {
  const map: Record<string, any[]> = {};
  for (const box of boxes.value) {
    const code = box.shelfCode ?? "Unassigned";
    if (!map[code]) map[code] = [];
    map[code].push(box);
  }
  return map;
});

function shelfLabel(code: string) {
  const shelf = shelves.value.find((s) => s.code === code);
  return shelf?.zone ? `${shelf.code} — ${shelf.zone}` : shelf?.code ?? code;
}

watch(
  () => boxes.value,
  (boxList) => {
    const next = new Set<string>();
    for (const b of boxList) {
      if (b.status === "open") next.add(b.id);
    }
    expandedItemBoxes.value = next;
  },
  { immediate: true, deep: true }
);

function toggleItemVisibility(boxId: string) {
  const next = new Set(expandedItemBoxes.value);
  if (next.has(boxId)) {
    next.delete(boxId);
  } else {
    next.add(boxId);
  }
  expandedItemBoxes.value = next;
}
```

- [ ] **Step 4: Add dialog handlers**

Replace the existing `createBox` function with:

```typescript
function openNewBoxDialog() {
  newBoxDialogOpen.value = true;
}

async function createBoxFromDialog(shelfCode: string) {
  if (!currentUser?.id) {
    error.value = "Operator not signed in";
    return;
  }
  creating.value = true;
  try {
    await createShelfBox(db, orderId, shelfCode, currentUser.id);
    await load();
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  } finally {
    creating.value = false;
  }
}
```

Remove the old `selectedShelf` ref (it is no longer needed).

- [ ] **Step 5: Replace the Shelf boxes card content**

Replace the Shelf boxes card block:

```vue
      <div class="card" style="margin-bottom: 1.5rem;">
        <div class="section-title" style="display: flex; justify-content: space-between; align-items: center; margin: 0 0 1rem;">
          <h2 style="margin: 0;">Shelf boxes({{ boxes.length }})</h2>
          <button
            class="btn btn--small btn--ghost"
            :aria-expanded="boxesExpanded"
            @click="boxesExpanded = !boxesExpanded"
          >
            {{ boxesExpanded ? "Hide" : `Show ${boxes.length}` }}
          </button>
        </div>

        <div v-if="boxesExpanded">
          <div style="display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; margin-bottom: 1rem;">
            <select v-model="selectedShelf" style="flex: 1; min-width: 10rem;" :disabled="creating">
              <option value="">Select a shelf</option>
              <option v-for="shelf in shelves" :key="shelf.code" :value="shelf.code">
                {{ shelf.zone ? `${shelf.code} — ${shelf.zone}` : shelf.code }}
              </option>
            </select>
            <button class="btn" :disabled="creating || !selectedShelf" @click="createBox">
              {{ creating ? "Creating…" : "Create box" }}
            </button>
          </div>

          <p v-if="boxes.length === 0" class="empty" style="padding: 0;">No boxes yet.</p>

          <div
            v-for="box in boxes"
            :key="box.id"
            class="card"
            style="margin-bottom: 0.75rem;"
            :class="{ 'card--done': box.status !== 'open' }"
          >
            <div class="detail-row">
              <span class="detail-label">Box</span>
              <span class="card__title">{{ box.id }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Shelf</span>
              <span>{{ box.shelfCode || "—" }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Status</span>
              <span class="badge" :class="badgeClass(box.status)">{{ box.status }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Items</span>
              <span>{{ box.items?.length || 0 }} lines · {{ boxTotalQty(box) }} pcs</span>
            </div>

            <div v-if="box.items?.length" style="margin-top: 0.5rem;">
              <p style="margin: 0 0 0.25rem; font-size: 0.8125rem; color: var(--muted);">Contents:</p>
              <div
                v-for="item in box.items"
                :key="item.id"
                class="lot"
              >
                <span>{{ item.part?.partNo || "—" }}</span>
                <span style="color: var(--muted);">× {{ item.qty }}</span>
              </div>
            </div>

            <div v-if="box.status === 'open'" style="margin-top: 1rem;">
              <button
                class="btn"
                :disabled="closing || !box.items?.length"
                @click="closeBox(box.id)"
              >
                {{ closing ? "Closing…" : "Close box" }}
              </button>
            </div>
          </div>
        </div>
      </div>
```

With:

```vue
      <div class="card" style="margin-bottom: 1.5rem;">
        <div class="section-title" style="display: flex; justify-content: space-between; align-items: center; margin: 0 0 1rem;">
          <h2 style="margin: 0;">Shelf boxes({{ boxes.length }})</h2>
          <div style="display: flex; gap: 0.5rem; align-items: center;">
            <button
              class="btn btn--small"
              :disabled="creating"
              @click="openNewBoxDialog"
            >
              {{ creating ? "Creating…" : "New box" }}
            </button>
            <button
              class="btn btn--small btn--ghost"
              :aria-expanded="boxesExpanded"
              @click="boxesExpanded = !boxesExpanded"
            >
              {{ boxesExpanded ? "Hide" : "Show" }}
            </button>
          </div>
        </div>

        <SelectShelfDialog
          v-model="newBoxDialogOpen"
          :shelves="shelves"
          @selected="createBoxFromDialog"
        />

        <div v-if="boxesExpanded">
          <p v-if="boxes.length === 0" class="empty" style="padding: 0;">No boxes yet.</p>

          <div
            v-for="(group, shelfCode) in boxesByShelf"
            :key="shelfCode"
            style="margin-bottom: 1.5rem;"
          >
            <h3 class="subsection-title">{{ shelfLabel(shelfCode) }}</h3>

            <div
              v-for="box in group"
              :key="box.id"
              class="card"
              style="margin-bottom: 0.75rem;"
              :class="{ 'card--done': box.status !== 'open' }"
            >
              <div class="detail-row">
                <span class="detail-label">Box</span>
                <span class="card__title">{{ box.id }}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Status</span>
                <span class="badge" :class="badgeClass(box.status)">{{ box.status }}</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Items</span>
                <span>{{ box.items?.length || 0 }} lines · {{ boxTotalQty(box) }} pcs</span>
              </div>

              <div v-if="box.items?.length" style="margin-top: 0.5rem;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
                  <p style="margin: 0; font-size: 0.8125rem; color: var(--muted);">Contents</p>
                  <button
                    class="btn btn--small btn--ghost"
                    @click="toggleItemVisibility(box.id)"
                  >
                    {{ expandedItemBoxes.has(box.id) ? "Hide items" : "Show items" }}
                  </button>
                </div>
                <div v-if="expandedItemBoxes.has(box.id)">
                  <div
                    v-for="item in box.items"
                    :key="item.id"
                    class="lot"
                  >
                    <span>{{ item.part?.partNo || "—" }}</span>
                    <span style="color: var(--muted);">× {{ item.qty }}</span>
                  </div>
                </div>
              </div>

              <div v-if="box.status === 'open'" style="margin-top: 1rem;">
                <button
                  class="btn"
                  :disabled="closing || !box.items?.length"
                  @click="closeBox(box.id)"
                >
                  {{ closing ? "Closing…" : "Close box" }}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
```

- [ ] **Step 6: Remove unused `selectedShelf` ref**

Delete:

```typescript
const selectedShelf = ref("");
```

- [ ] **Step 7: Generate types**

Run: `pnpm nuxt prepare`

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add pages/put-away/[id].vue
git commit -m "ui(put-away): redesign shelf boxes with dialog, shelf grouping, item visibility"
```

---

### Task 4: Verification

- [ ] **Step 1: Type check and build**

Run:

```bash
pnpm nuxt prepare
pnpm generate
```

Expected: both complete without errors.

- [ ] **Step 2: Manual browser test — picking detail**

1. Open a picking order detail.
2. Confirm the Boxes header shows `Boxes(0)` and a **New box** button + **Show** toggle.
3. Click **New box** and confirm a shipping box is created.
4. Confirm the count updates and the section can be expanded/collapsed.
5. Confirm no Create box button remains inside the expanded content.

- [ ] **Step 3: Manual browser test — put-away detail**

1. Open a put-away order detail.
2. Confirm the Shelf boxes header shows `Shelf boxes(0)` and a **New box** button + **Show** toggle.
3. Click **New box**, select a shelf, and confirm.
4. Confirm the section expands and the new box appears under the correct shelf group.
5. Confirm closed boxes hide their item list by default, and open boxes show it by default.
6. Confirm the per-box **Show items / Hide items** toggle works.

- [ ] **Step 4: Commit verification notes (optional)**

```bash
git commit --allow-empty -m "verify: boxes section redesign"
```

---

## Plan self-review

- **Spec coverage:**
  - Common header pattern with count + New box + toggle → Tasks 2 and 3.
  - Picking New box creates directly → Task 2.
  - Put-away New box opens shelf dialog → Tasks 1 and 3.
  - Put-away shelf grouping → Task 3 Step 3.
  - Per-box item visibility with closed-box default → Task 3 Step 3.
- **Placeholder scan:** No TBD/TODO placeholders; all steps include exact code.
- **Type consistency:** `boxesByShelf`, `expandedItemBoxes`, `newBoxDialogOpen`, and `shelfLabel` are defined before use in the template.
