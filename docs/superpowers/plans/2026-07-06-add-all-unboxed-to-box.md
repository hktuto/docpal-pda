# Add All Unboxed Items to Box — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an “Add” button on open boxes in receiving picking and put-away that batch-moves all eligible unboxed items/scans into that box.

**Architecture:** Two focused DB helpers (`addAllUnboxedPackagesToBox` in `db/picking.ts`, `addAllUnboxedScansToBox` in `db/putAway.ts`) run the existing single-add logic in a transaction. UI components emit an `add-all-to-box` event; parent pages handle state and refresh.

**Tech Stack:** Vue 3, Nuxt 3, PGlite, Drizzle ORM, TypeScript, Vitest.

---

### Task 1: Add `addAllUnboxedPackagesToBox` helper and test

**Files:**
- Modify: `db/picking.ts`
- Test: `tests/picking.test.ts` (create if missing)

- [ ] **Step 1: Write the failing test**

Create `tests/picking.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { v4 as uuid } from 'uuid';
import * as schema from '../db/schema';
import { createTablesSql } from '../db/init';
import { addAllUnboxedPackagesToBox, createShippingBoxForPickingOrder } from '../db/picking';

async function createTestDb() {
  const pg = new PGlite();
  await pg.waitReady;
  await pg.exec(createTablesSql);
  return drizzle(pg, { schema });
}

describe('addAllUnboxedPackagesToBox', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let pickingOrderId: string;
  let boxId: string;
  let actorId: string;

  beforeEach(async () => {
    db = await createTestDb();
    const now = new Date();
    actorId = uuid();
    await db.insert(schema.users).values({ id: actorId, username: 'op', passwordHash: 'pw', displayName: 'Op', role: 'operator', createdAt: now });

    const supplierId = uuid();
    await db.insert(schema.suppliers).values({ id: supplierId, code: 'KOA', name: 'KOA' });

    const partId = uuid();
    await db.insert(schema.parts).values({ id: partId, partNo: 'RK73B1JTTD181G', internalCode: '', description: '', defaultCoo: 'CN' });

    pickingOrderId = uuid();
    await db.insert(schema.pickingOrders).values({
      id: pickingOrderId,
      refNo: 'PICK-001',
      supplierId,
      deliveryDate: now,
      poNo: 'PO-001',
      requiredDateCodeNotice: null,
      shipTo: 'US',
      destinationCountry: 'USA',
      status: 'picking',
      createdAt: now,
      updatedAt: now,
    });

    const pickingItemId = uuid();
    await db.insert(schema.pickingItems).values({ id: pickingItemId, pickingOrderId, partId, qty: 100, pickedQty: 0, allocatedQty: 0 });

    boxId = await createShippingBoxForPickingOrder(db, pickingOrderId, actorId);

    // Create two unboxed packages
    for (let i = 0; i < 2; i++) {
      await db.insert(schema.pickingPackages).values({
        id: uuid(),
        pickingItemId,
        pickingOrderId,
        sourceType: 'inventory_lot',
        sourceId: uuid(),
        qty: 10,
        shippingBoxId: null,
        dateCode: '2544',
        lotCode: 'L1',
        coo: 'CN',
        cow: 'USA',
        createdAt: now,
      });
    }
  });

  it('adds all unboxed packages to the box', async () => {
    const count = await addAllUnboxedPackagesToBox(db, boxId, actorId);
    expect(count).toBe(2);

    const boxed = await db.query.pickingPackages.findMany({ where: (pp, { eq }) => eq(pp.shippingBoxId, boxId) });
    expect(boxed).toHaveLength(2);
  });

  it('returns 0 when no unboxed packages exist', async () => {
    await addAllUnboxedPackagesToBox(db, boxId, actorId);
    const count = await addAllUnboxedPackagesToBox(db, boxId, actorId);
    expect(count).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/picking.test.ts`
Expected: FAIL — `addAllUnboxedPackagesToBox` is not exported.

- [ ] **Step 3: Implement `addAllUnboxedPackagesToBox`**

Add to `db/picking.ts` after `addPackageToBox`:

```ts
export async function addAllUnboxedPackagesToBox(
  db: PgliteDatabase<typeof schema>,
  shippingBoxId: string,
  actorId: string
): Promise<number> {
  return db.transaction(async (tx) => {
    const box = await tx.query.shippingBoxes.findFirst({
      where: eq(schema.shippingBoxes.id, shippingBoxId),
    });
    if (!box) throw new I18nError('box_not_found');
    if (box.status !== 'open') throw new I18nError('box_is_not_open');

    const packages = await tx.query.pickingPackages.findMany({
      where: and(
        eq(schema.pickingPackages.pickingOrderId, box.pickingOrderId),
        isNull(schema.pickingPackages.shippingBoxId)
      ),
    });

    for (const pkg of packages) {
      await addPackageToBox(tx as any, pkg.id, shippingBoxId, actorId);
    }

    return packages.length;
  });
}
```

Note: `addPackageToBox` already validates inside its own transaction; wrapping in another transaction is acceptable because PGlite transactions can be nested via passing `tx`.

- [ ] **Step 4: Run tests**

Run: `pnpm test tests/picking.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add db/picking.ts tests/picking.test.ts
git commit -m "feat(db): add addAllUnboxedPackagesToBox helper with tests"
```

---

### Task 2: Wire receiving picking tab UI

**Files:**
- Modify: `components/receiving/ReceivingPickingTab.vue`
- Modify: `pages/receiving/[id].vue`
- Modify: `i18n/locales/en.json` (or wherever keys live)

- [ ] **Step 1: Add emit and button in `ReceivingPickingTab.vue`**

Add `"add-all-to-box": [boxId: string]` to `defineEmits`.

In the box list template, add the button:

```vue
<button
  class="btn btn--small"
  :disabled="addingAll[box.id] || !hasUnboxedPackages(po.id)"
  @click="emit('add-all-to-box', box.id)"
>
  <template v-if="addingAll[box.id]">
    <InlineSpinner /> {{ $t('receiving.pickingTab.addAll') }}
  </template>
  <template v-else>
    {{ $t('receiving.pickingTab.addAll') }}
  </template>
</button>
```

Add props `addingAll: Record<string, boolean>`.

Add helper:

```ts
function hasUnboxedPackages(pickingOrderId: string) {
  const items = props.filteredGroupedPickingOrders.find((po) => po.id === pickingOrderId)?.items ?? [];
  for (const item of items) {
    const packages = props.packagesByItem[item.id] ?? [];
    if (packages.some((p) => !p.shippingBoxId)) return true;
  }
  return false;
}
```

- [ ] **Step 2: Handle event in `pages/receiving/[id].vue`**

Add state: `const addingAll = ref<Record<string, boolean>>({});`

Add handler:

```ts
async function addAllToBox(boxId: string) {
  addingAll.value[boxId] = true;
  try {
    if (!currentUser.value) throw new I18nError('no_operator_user_found');
    await addAllUnboxedPackagesToBox(db, boxId, currentUser.value.id);
    await load();
  } catch (e: any) {
    error.value = errorMessage(e);
  } finally {
    addingAll.value[boxId] = false;
  }
}
```

Bind `adding-all` prop and `@add-all-to-box` event on `ReceivingPickingTab`.

Import `addAllUnboxedPackagesToBox` from `~/db/picking`.

- [ ] **Step 3: Add i18n key**

Add `addAll: "Add"` under `receiving.pickingTab`.

- [ ] **Step 4: Verify types and tests**

Run: `pnpm nuxt prepare && pnpm test`
Expected: types generate, tests pass.

- [ ] **Step 5: Commit**

```bash
git add components/receiving/ReceivingPickingTab.vue pages/receiving/[id].vue i18n/locales/en.json
git commit -m "feat(receiving): add Add button to batch-box unboxed picking packages"
```

---

### Task 3: Add `addAllUnboxedScansToBox` helper and test

**Files:**
- Modify: `db/putAway.ts`
- Test: `tests/putAway.test.ts` (create if missing)

- [ ] **Step 1: Write the failing test**

Create `tests/putAway.test.ts` similar to the picking test, using `putAwayScans`, `shelfBoxes`, and `assignScanToBox`.

Test cases:
- Adds all unboxed scans to the shelf box.
- Returns 0 when none are unboxed.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/putAway.test.ts`
Expected: FAIL — helper not exported.

- [ ] **Step 3: Implement `addAllUnboxedScansToBox`**

Add to `db/putAway.ts` after `assignScanToBox`:

```ts
export async function addAllUnboxedScansToBox(
  db: PgliteDatabase<typeof schema>,
  shelfBoxId: string,
  actorId: string
): Promise<number> {
  return db.transaction(async (tx) => {
    const [box] = await tx
      .select()
      .from(schema.shelfBoxes)
      .where(eq(schema.shelfBoxes.id, shelfBoxId));
    if (!box) throw new I18nError('shelf_box_not_found');
    if (box.status !== 'open') throw new I18nError('shelf_box_is_not_open');

    const scans = await tx.execute(sql`
      SELECT pas.*
      FROM put_away_scans pas
      JOIN receiving_invoice_items rii ON rii.id = pas.receiving_invoice_item_id
      JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
      WHERE ri.receiving_order_id = ${box.receivingOrderId}
        AND pas.shelf_box_id IS NULL
    `);

    for (const raw of scans.rows ?? []) {
      await assignScanToBox(tx as any, String(raw.id), shelfBoxId, actorId);
    }

    return scans.rows?.length ?? 0;
  });
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm test tests/putAway.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add db/putAway.ts tests/putAway.test.ts
git commit -m "feat(db): add addAllUnboxedScansToBox helper with tests"
```

---

### Task 4: Wire put-away UI

**Files:**
- Modify: `components/put-away/ShelfBoxesPanel.vue`
- Modify: `pages/put-away/[id].vue`
- Modify: `i18n/locales/en.json`

- [ ] **Step 1: Add emit, prop, and button in `ShelfBoxesPanel.vue`**

Add `"add-all-to-box": [boxId: string]` to emits.
Add prop `addingAll: Record<string, boolean>`.
Add prop `unboxedCountByBoxId: Record<string, number>`.

Inside each open box card, add:

```vue
<button
  v-if="box.status === 'open'"
  class="btn btn--small"
  :disabled="addingAll[box.id] || !(unboxedCountByBoxId[box.id] > 0)"
  @click="emit('add-all-to-box', box.id)"
>
  <template v-if="addingAll[box.id]">
    <InlineSpinner /> {{ $t('putAway.shelfBoxesPanel.addAll') }}
  </template>
  <template v-else>
    {{ $t('putAway.shelfBoxesPanel.addAll') }}
  </template>
</button>
```

- [ ] **Step 2: Handle event in `pages/put-away/[id].vue`**

Add state: `const addingAll = ref<Record<string, boolean>>({});`

Compute:

```ts
const unboxedCountByBoxId = computed(() => {
  const counts: Record<string, number> = {};
  for (const box of boxes.value) {
    counts[box.id] = scans.value.filter(
      (s) => !s.shelfBoxId && box.receivingOrderId === orderId
    ).length;
  }
  return counts;
});
```

Add handler:

```ts
async function addAllToBox(boxId: string) {
  addingAll.value[boxId] = true;
  error.value = null;
  try {
    await addAllUnboxedScansToBox(db, boxId, currentUserId());
    await load();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    addingAll.value[boxId] = false;
  }
}
```

Pass `:adding-all` and `:unboxed-count-by-box-id` to `ShelfBoxesPanel`; listen for `@add-all-to-box`.

Import `addAllUnboxedScansToBox` from `~/db/putAway`.

- [ ] **Step 3: Add i18n key**

Add `addAll: "Add"` under `putAway.shelfBoxesPanel`.

- [ ] **Step 4: Verify types and tests**

Run: `pnpm nuxt prepare && pnpm test`
Expected: types generate, all tests pass.

- [ ] **Step 5: Commit**

```bash
git add components/put-away/ShelfBoxesPanel.vue pages/put-away/[id].vue i18n/locales/en.json
git commit -m "feat(put-away): add Add button to batch-box unboxed scans"
```

---

### Task 5: Final verification

- [ ] **Step 1: Run full test suite**

Run: `pnpm test`
Expected: all tests pass.

- [ ] **Step 2: Manual browser check**

Run `pnpm dev`, log in as `operator` / `DocPal2026!`, navigate to a receiving order’s picking tab and a put-away order, and confirm:
- “Add” button appears on open boxes.
- Button is disabled when no unboxed items exist.
- Tapping “Add” moves all eligible items into the box and refreshes the list.

- [ ] **Step 3: Commit any final fixes**

---

## Self-review

**Spec coverage:**
- Receiving picking Add button: Task 2.
- Put-away Add button: Task 4.
- Transactional batch helpers: Tasks 1 and 3.
- Disabled state: included in each UI task.
- i18n: included.

**Placeholder scan:** No TBD/TODO placeholders.

**Type consistency:** `addingAll` uses `Record<string, boolean>` in both flows. `addAllToBox` handlers use matching box IDs.
