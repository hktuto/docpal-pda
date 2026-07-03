# Cancel empty box Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow operators to cancel (delete) an open box that has no items, for both picking shipping boxes and put-away shelf boxes.

**Architecture:** Add a transactional DB helper per box type that verifies the box is open and empty before deleting. Surface a Cancel button on each detail page only when those conditions hold.

**Tech Stack:** Nuxt 3, Vue 3, PGlite, Drizzle ORM, plain CSS.

---

### Task 1: Add `cancelShippingBox` helper in `db/picking.ts`

**Files:**
- Modify: `db/picking.ts`

- [ ] **Step 1: Add the helper after `createShippingBoxForPickingOrder`**

```typescript
export async function cancelShippingBox(
  db: PgliteDatabase<typeof schema>,
  boxId: string
): Promise<void> {
  return db.transaction(async (tx) => {
    const box = await tx.query.shippingBoxes.findFirst({
      where: eq(schema.shippingBoxes.id, boxId),
    });
    if (!box) throw new Error("Box not found");
    if (box.status !== "open") throw new Error("Box is not open");

    const packageResult = await tx
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(schema.pickingPackages)
      .where(eq(schema.pickingPackages.shippingBoxId, boxId));
    if (packageResult[0]?.count > 0) throw new Error("Box is not empty");

    const itemResult = await tx
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(schema.shippingBoxItems)
      .where(eq(schema.shippingBoxItems.shippingBoxId, boxId));
    if (itemResult[0]?.count > 0) throw new Error("Box is not empty");

    await tx.delete(schema.shippingBoxes).where(eq(schema.shippingBoxes.id, boxId));
  });
}
```

- [ ] **Step 2: Verify no type errors**

Run: `pnpm nuxt prepare`

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add db/picking.ts
git commit -m "db(picking): add cancelShippingBox helper"
```

---

### Task 2: Add `cancelShelfBox` helper in `db/putAway.ts`

**Files:**
- Modify: `db/putAway.ts`

- [ ] **Step 1: Add the helper after `createShelfBox`**

```typescript
export async function cancelShelfBox(
  db: PgliteDatabase<typeof schema>,
  boxId: string
): Promise<void> {
  return db.transaction(async (tx) => {
    const box = await tx.query.shelfBoxes.findFirst({
      where: eq(schema.shelfBoxes.id, boxId),
    });
    if (!box) throw new Error("Box not found");
    if (box.status !== "open") throw new Error("Box is not open");

    const itemResult = await tx
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(schema.shelfBoxItems)
      .where(eq(schema.shelfBoxItems.shelfBoxId, boxId));
    if (itemResult[0]?.count > 0) throw new Error("Box is not empty");

    await tx.delete(schema.shelfBoxes).where(eq(schema.shelfBoxes.id, boxId));
  });
}
```

- [ ] **Step 2: Verify no type errors**

Run: `pnpm nuxt prepare`

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add db/putAway.ts
git commit -m "db(put-away): add cancelShelfBox helper"
```

---

### Task 3: Add Cancel button to picking detail page

**Files:**
- Modify: `pages/picking/[id].vue`

- [ ] **Step 1: Import `cancelShippingBox`**

Change:
```typescript
import {
  getPickingOrderDetail,
  createShippingBoxForPickingOrder,
  addPackageToBox,
  removePackageFromBox,
  finishPickingOrder,
  getPickingItemTransitionLogs,
} from "~/db/picking";
```

To:
```typescript
import {
  getPickingOrderDetail,
  createShippingBoxForPickingOrder,
  addPackageToBox,
  removePackageFromBox,
  cancelShippingBox,
  finishPickingOrder,
  getPickingItemTransitionLogs,
} from "~/db/picking";
```

- [ ] **Step 2: Add cancelling state ref**

After:
```typescript
const creatingBox = ref(false);
```

Add:
```typescript
const cancellingBox = ref<Record<string, boolean>>({});
```

- [ ] **Step 3: Add cancel handler**

After the `createBox` function, add:

```typescript
async function cancelBox(boxId: string) {
  cancellingBox.value[boxId] = true;
  try {
    if (!currentUser) throw new Error("No operator user found");
    await cancelShippingBox(db, boxId);
    await load();
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  } finally {
    cancellingBox.value[boxId] = false;
  }
}
```

- [ ] **Step 4: Add Cancel button in each shipping box card**

Find the block that renders each shipping box (around the Box ID / Status / Packages rows). After the package count rows, add:

```vue
              <div v-if="box.status === 'open' && (box.packages?.length ?? 0) === 0" style="margin-top: 1rem;">
                <button
                  class="btn btn--small btn--danger"
                  :disabled="cancellingBox[box.id]"
                  @click="cancelBox(box.id)"
                >
                  {{ cancellingBox[box.id] ? "Cancelling…" : "Cancel box" }}
                </button>
              </div>
```

- [ ] **Step 5: Verify no type errors**

Run: `pnpm nuxt prepare`

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add pages/picking/[id].vue
git commit -m "feat(picking): add cancel button for empty shipping boxes"
```

---

### Task 4: Add Cancel button to put-away detail page

**Files:**
- Modify: `pages/put-away/[id].vue`

- [ ] **Step 1: Import `cancelShelfBox`**

Change:
```typescript
import {
  getReceivingOrderDetail,
  getPutAwayLots,
  createShelfBox,
  addItemToShelfBox,
  closeShelfBox,
  getShelfBoxesForReceivingOrder,
} from "~/db/putAway";
```

To:
```typescript
import {
  getReceivingOrderDetail,
  getPutAwayLots,
  createShelfBox,
  addItemToShelfBox,
  closeShelfBox,
  cancelShelfBox,
  getShelfBoxesForReceivingOrder,
} from "~/db/putAway";
```

- [ ] **Step 2: Add cancelling state ref**

After:
```typescript
const closing = ref(false);
```

Add:
```typescript
const cancellingBox = ref<Record<string, boolean>>({});
```

- [ ] **Step 3: Add cancel handler**

After the `closeBox` function, add:

```typescript
async function cancelBox(boxId: string) {
  cancellingBox.value[boxId] = true;
  try {
    if (!currentUser) throw new Error("No operator user found");
    await cancelShelfBox(db, boxId);
    await load();
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  } finally {
    cancellingBox.value[boxId] = false;
  }
}
```

- [ ] **Step 4: Add Cancel button in each shelf box card**

In the shelf box card, after the existing Close box button block, add a Cancel button block:

```vue
              <div v-if="box.status === 'open' && (box.items?.length ?? 0) === 0" style="margin-top: 1rem;">
                <button
                  class="btn btn--small btn--danger"
                  :disabled="cancellingBox[box.id]"
                  @click="cancelBox(box.id)"
                >
                  {{ cancellingBox[box.id] ? "Cancelling…" : "Cancel box" }}
                </button>
              </div>
```

- [ ] **Step 5: Verify no type errors**

Run: `pnpm nuxt prepare`

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add pages/put-away/[id].vue
git commit -m "feat(put-away): add cancel button for empty shelf boxes"
```

---

### Task 5: Verification

- [ ] **Step 1: Type check and build**

Run:
```bash
pnpm nuxt prepare
pnpm build
```

Expected: both complete without errors.

- [ ] **Step 2: Manual browser test — picking**

1. Open a picking order detail.
2. Create a new shipping box.
3. Verify a **Cancel box** button appears on the empty box.
4. Click **Cancel box** and confirm the box disappears.
5. Add a package to a box and confirm **Cancel box** is hidden.

- [ ] **Step 3: Manual browser test — put-away**

1. Open a put-away order detail.
2. Create a new shelf box.
3. Verify a **Cancel box** button appears on the empty box.
4. Click **Cancel box** and confirm the box disappears.
5. Add an item to a box and confirm **Cancel box** is hidden.

- [ ] **Step 4: Commit verification notes (optional)**

```bash
git commit --allow-empty -m "verify: cancel empty box"
```
