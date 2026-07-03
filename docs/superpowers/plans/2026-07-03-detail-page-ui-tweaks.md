# Detail page UI tweaks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse secondary sections on the picking and put-away detail pages, group box creation with box lists, and de-emphasize the picking-logs toggle.

**Architecture:** Add local `boxesExpanded` state to each detail page and conditionally render the box list; move the picking Create box button into the expanded Boxes section; restyle the picking logs toggle as a neutral ghost button.

**Tech Stack:** Nuxt 3, Vue 3, plain CSS.

---

## File map

| File | Change |
|------|--------|
| `pages/picking/[id].vue` | Collapsible Boxes section, move Create box button, neutral logs toggle. |
| `pages/put-away/[id].vue` | Collapsible Shelf boxes section. |

---

### Task 1: Update `pages/picking/[id].vue`

**Files:**
- Modify: `pages/picking/[id].vue`

- [ ] **Step 1: Remove Create box from `DetailHeader` actions**

Replace the actions block:

```vue
        <template #actions>
          <template v-if="order.status !== 'finished' && order.status !== 'issue'">
            <button class="btn btn--small" :disabled="creatingBox" @click="createBox">
              {{ creatingBox ? "Creating…" : "Create box" }}
            </button>
            <button
              v-if="allItemsFullyBoxed"
              class="btn btn--small"
              :disabled="finishing"
              @click="finish"
            >
              {{ finishing ? "Finishing…" : "Finish picking" }}
            </button>
          </template>
          <NuxtLink
            v-if="order.status === 'finished' && order.measuringTask"
            :to="`/measuring/${order.measuringTask.id}`"
            class="btn btn--small"
          >
            Measuring
          </NuxtLink>
        </template>
```

With:

```vue
        <template #actions>
          <template v-if="order.status !== 'finished' && order.status !== 'issue'">
            <button
              v-if="allItemsFullyBoxed"
              class="btn btn--small"
              :disabled="finishing"
              @click="finish"
            >
              {{ finishing ? "Finishing…" : "Finish picking" }}
            </button>
          </template>
          <NuxtLink
            v-if="order.status === 'finished' && order.measuringTask"
            :to="`/measuring/${order.measuringTask.id}`"
            class="btn btn--small"
          >
            Measuring
          </NuxtLink>
        </template>
```

- [ ] **Step 2: Make the Boxes section collapsible and move Create box inside**

Replace:

```vue
      <h2 class="section-title">Boxes</h2>
      <p v-if="!order.shippingBoxes?.length" class="empty" style="margin-bottom: 1.5rem;">No boxes yet.</p>
      <div
        v-for="box in order.shippingBoxes"
        :key="box.id"
        class="card"
        style="margin-bottom: 1rem;"
        :class="{ 'card--done': box.status !== 'open' }"
      >
```

With:

```vue
      <h2 class="section-title" style="display: flex; justify-content: space-between; align-items: center;">
        Boxes
        <button class="btn btn--small btn--ghost" @click="boxesExpanded = !boxesExpanded">
          {{ boxesExpanded ? "Hide" : `Show ${order.shippingBoxes?.length ?? 0}` }}
        </button>
      </h2>

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

        <div
          v-for="box in order.shippingBoxes"
          :key="box.id"
          class="card"
          style="margin-bottom: 1rem;"
          :class="{ 'card--done': box.status !== 'open' }"
        >
```

- [ ] **Step 3: Close the collapsible Boxes wrapper**

After the last `</div>` of the box list (the one that closes the `v-for` card), add a closing `</div>` for the wrapper.

The original structure is:

```vue
      </div>

      <h2 class="section-title">Items</h2>
```

Change it to:

```vue
      </div>
      </div>

      <h2 class="section-title">Items</h2>
```

- [ ] **Step 4: Neutral style for Show/Hide picking logs button**

Replace:

```vue
          <button class="btn btn--small" @click="toggleExpand(item.id)">
            {{ expandedItems.has(item.id) ? "Hide picking logs" : "Show picking logs" }}
            ({{ (transitionLogs[item.id] || []).length }})
          </button>
```

With:

```vue
          <button class="btn btn--small btn--ghost" @click="toggleExpand(item.id)">
            {{ expandedItems.has(item.id) ? "Hide picking logs" : "Show picking logs" }}
            ({{ (transitionLogs[item.id] || []).length }})
          </button>
```

- [ ] **Step 5: Add `boxesExpanded` state**

After:

```typescript
const headerExpanded = ref(false);
```

Add:

```typescript
const boxesExpanded = ref(false);
```

- [ ] **Step 6: Generate types**

Run: `pnpm nuxt prepare`

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add pages/picking/[id].vue
git commit -m "ui(picking): collapsible boxes section, move create box, neutral logs toggle"
```

---

### Task 2: Update `pages/put-away/[id].vue`

**Files:**
- Modify: `pages/put-away/[id].vue`

- [ ] **Step 1: Add `boxesExpanded` state**

After:

```typescript
const headerExpanded = ref(false);
```

Add:

```typescript
const boxesExpanded = ref(false);
```

- [ ] **Step 2: Make the Shelf boxes card collapsible**

Replace the Shelf boxes card block:

```vue
      <div class="card" style="margin-bottom: 1.5rem;">
        <h2 style="margin-top: 0; margin-bottom: 1rem;">Shelf boxes</h2>

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
```

With:

```vue
      <div class="card" style="margin-bottom: 1.5rem;">
        <h2 style="margin-top: 0; margin-bottom: 1rem; display: flex; justify-content: space-between; align-items: center;">
          Shelf boxes
          <button class="btn btn--small btn--ghost" @click="boxesExpanded = !boxesExpanded">
            {{ boxesExpanded ? "Hide" : `Show ${boxes.length}` }}
          </button>
        </h2>

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
```

- [ ] **Step 3: Close the collapsible Shelf boxes wrapper**

The card currently ends with:

```vue
        </div>
      </div>

      <h2 style="margin-top: 0; margin-bottom: 1rem; font-size: 1rem;">Available receiving-area lots</h2>
```

The inner `</div>` closes the last box card. We need to close the `boxesExpanded` wrapper div before closing the card. Change the tail to:

```vue
          </div>
        </div>
      </div>

      <h2 style="margin-top: 0; margin-bottom: 1rem; font-size: 1rem;">Available receiving-area lots</h2>
```

- [ ] **Step 4: Generate types**

Run: `pnpm nuxt prepare`

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add pages/put-away/[id].vue
git commit -m "ui(put-away): make shelf boxes section collapsible"
```

---

### Task 3: Verification

- [ ] **Step 1: Type check and build**

Run:

```bash
pnpm nuxt prepare
pnpm generate
```

Expected: both complete without errors.

- [ ] **Step 2: Manual browser test — picking detail**

1. Log in and open a picking order detail.
2. Confirm the **Boxes** section is collapsed by default.
3. Click **Show N** and confirm it expands, shows the **Create box** button, and lists boxes.
4. Click **Create box** and confirm it still works.
5. Confirm **Show picking logs** uses the ghost/neutral button style.
6. Confirm the **Finish picking** button still appears in the header when all items are boxed.

- [ ] **Step 3: Manual browser test — put-away detail**

1. Open a put-away order detail.
2. Confirm the **Shelf boxes** section is collapsed by default.
3. Click **Show N** and confirm it expands, shows the shelf selector + **Create box** button, and lists boxes.
4. Create a box and confirm it works.
5. Confirm the **Available receiving-area lots** section is visible while the boxes section is collapsed.

- [ ] **Step 4: Commit verification notes (optional)**

```bash
git commit --allow-empty -m "verify: detail page UI tweaks"
```

---

## Plan self-review

- **Spec coverage:**
  - Picking Boxes collapsible → Task 1 Steps 2–3.
  - Picking Create box moved → Task 1 Steps 1–2.
  - Picking logs neutral style → Task 1 Step 4.
  - Put-away Shelf boxes collapsible → Task 2.
- **Placeholder scan:** No TBD/TODO placeholders; all steps include exact code snippets and commands.
- **Type consistency:** `boxesExpanded` is introduced and used consistently in each page; existing refs (`creatingBox`, `creating`, `selectedShelf`) are unchanged.
