# Receiving mismatch approval + schema consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract receiving item mismatches into a dedicated approval-workflow table, remove `shipping_box_items`, and merge `shelf_box_items` into `put_away_scans`.

**Architecture:** A new `receiving_item_mismatches` table owns the full mismatch lifecycle (`pending` → `confirmed`/`cancelled`) and stores the effective received quantity. `receiving_invoice_items` keeps only physical movement quantities. `put_away_scans` gains `verified`/`verifiedAt` so shelf-box contents and verification state can be derived from scans. All other tables remain unchanged.

**Tech Stack:** Nuxt 3, Vue 3, PGlite, Drizzle ORM, Vitest.

---

## File structure

| File | Responsibility |
|------|----------------|
| `db/schema.ts` | Drizzle table definitions and relations. |
| `db/init.ts` | Raw SQL bootstrap executed on first PGlite load. |
| `db/mismatch.ts` | New mismatch helpers: validation, computation, CRUD, guards. |
| `db/receiving.ts` | Receiving helpers; updated to use active mismatches on arrival. |
| `db/putAway.ts` | Put-away scan logic; removes `shelf_box_items` references. |
| `db/picking.ts` | Picking helpers; removes `shipping_box_items` check. |
| `db/goodsVerify.ts` | Goods-verify logic; reads/writes scan verification state. |
| `db/seed.ts` | Seed data; removes deleted tables/columns. |
| `components/receiving/types.ts` | Display types for receiving detail. |
| `components/receiving/ReceivingItemsTab.vue` | Receiving item cards with mismatch status/actions. |
| `components/ReportIssueModal.vue` | Modal for reporting/editing mismatches. |
| `pages/receiving/[id].vue` | Receiving detail page; loads mismatches and wires actions. |
| `i18n/locales/en-US.json` | English strings for new UI states. |
| `i18n/locales/zh-CN.json` | Chinese strings for new UI states. |
| `i18n/locales/zh-HK.json` | Traditional Chinese strings for new UI states. |
| `tests/mismatch.test.ts` | Unit tests for mismatch helpers. |
| `tests/putAway.test.ts` | Updated put-away tests. |

---

## Task 1: Update Drizzle schema (`db/schema.ts`)

**Files:**
- Modify: `db/schema.ts`
- Test: `pnpm nuxt prepare`

- [ ] **Step 1: Add `mismatchStatuses` and `receivingItemMismatches` table**

  Insert after the `mismatchReasons` definition (around line 72):

  ```ts
  export const mismatchStatuses = ["pending", "confirmed", "cancelled"] as const;

  export const receivingItemMismatches = pgTable("receiving_item_mismatches", {
    id: text("id").primaryKey(),
    receivingInvoiceItemId: text("receiving_invoice_item_id")
      .notNull()
      .references(() => receivingInvoiceItems.id, { onDelete: "cascade" }),
    reason: text("reason", { enum: mismatchReasons }).notNull(),
    mismatchQty: integer("mismatch_qty"),
    wrongPartNo: text("wrong_part_no"),
    note: text("note"),
    status: text("status", { enum: mismatchStatuses }).notNull().default("pending"),
    effectiveReceivedQty: integer("effective_received_qty").notNull(),
    previousReceivedQty: integer("previous_received_qty").notNull(),
    reportedBy: text("reported_by").references(() => users.id),
    reportedAt: timestamp("reported_at").notNull(),
    confirmedBy: text("confirmed_by").references(() => users.id),
    confirmedAt: timestamp("confirmed_at"),
    cancelledBy: text("cancelled_by").references(() => users.id),
    cancelledAt: timestamp("cancelled_at"),
  });
  ```

- [ ] **Step 2: Remove mismatch columns from `receivingInvoiceItems`**

  Replace the `receivingInvoiceItems` definition with:

  ```ts
  export const receivingInvoiceItems = pgTable("receiving_invoice_items", {
    id: text("id").primaryKey(),
    receivingInvoiceId: text("receiving_invoice_id")
      .notNull()
      .references(() => receivingInvoices.id, { onDelete: "cascade" }),
    partId: text("part_id").notNull().references(() => parts.id),
    poNo: text("po_no"),
    poLine: text("po_line"),
    qty: integer("qty").notNull(),
    receivedQty: integer("received_qty").notNull().default(0),
    pickedQty: integer("picked_qty").notNull().default(0),
    putAwayQty: integer("put_away_qty").notNull().default(0),
    boxId: text("box_id"),
    dateCode: text("date_code"),
    lotCode: text("lot_code"),
    coo: text("coo"),
    cow: text("cow"),
  });
  ```

- [ ] **Step 3: Add `verified`/`verifiedAt` to `putAwayScans`**

  Add to `putAwayScans`:

  ```ts
  verified: boolean("verified").notNull().default(false),
  verifiedAt: timestamp("verified_at"),
  ```

- [ ] **Step 4: Remove `shippingBoxItems` table and its relation**

  Delete the entire `shippingBoxItems` table definition and `shippingBoxItemsRelations`.

- [ ] **Step 5: Remove `shelfBoxItems` table and update relations**

  Delete the entire `shelfBoxItems` table definition and `shelfBoxItemsRelations`. Update `shelfBoxesRelations` to remove `items: many(shelfBoxItems)`.

- [ ] **Step 6: Add `receivingItemMismatches` relations**

  Add after `receivingInvoiceItemsRelations`:

  ```ts
  export const receivingItemMismatchesRelations = relations(receivingItemMismatches, ({ one }) => ({
    receivingInvoiceItem: one(receivingInvoiceItems, { fields: [receivingItemMismatches.receivingInvoiceItemId], references: [receivingInvoiceItems.id] }),
    reportedByUser: one(users, { fields: [receivingItemMismatches.reportedBy], references: [users.id] }),
    confirmedByUser: one(users, { fields: [receivingItemMismatches.confirmedBy], references: [users.id] }),
    cancelledByUser: one(users, { fields: [receivingItemMismatches.cancelledBy], references: [users.id] }),
  }));
  ```

  Update `receivingInvoiceItemsRelations` to add `mismatches: many(receivingItemMismatches)`.

- [ ] **Step 7: Run type generation**

  Run: `pnpm nuxt prepare`
  Expected: succeeds with no type errors.

---

## Task 2: Update raw SQL bootstrap (`db/init.ts`)

**Files:**
- Modify: `db/init.ts`
- Test: `pnpm nuxt prepare`

- [ ] **Step 1: Add `receiving_item_mismatches` table SQL**

  Insert after `receiving_invoice_items` SQL:

  ```sql
  CREATE TABLE IF NOT EXISTS receiving_item_mismatches (
    id TEXT PRIMARY KEY,
    receiving_invoice_item_id TEXT NOT NULL REFERENCES receiving_invoice_items(id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    mismatch_qty INTEGER,
    wrong_part_no TEXT,
    note TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    effective_received_qty INTEGER NOT NULL,
    previous_received_qty INTEGER NOT NULL,
    reported_by TEXT REFERENCES users(id),
    reported_at TIMESTAMP NOT NULL,
    confirmed_by TEXT REFERENCES users(id),
    confirmed_at TIMESTAMP,
    cancelled_by TEXT REFERENCES users(id),
    cancelled_at TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_receiving_item_mismatches_item ON receiving_item_mismatches(receiving_invoice_item_id);
  CREATE INDEX IF NOT EXISTS idx_receiving_item_mismatches_status ON receiving_item_mismatches(status);
  ```

- [ ] **Step 2: Update `receiving_invoice_items` SQL**

  Remove `reported_mismatch`, `mismatch_reason`, `mismatch_qty`, `wrong_part_no`, and `mismatch_note` columns.

- [ ] **Step 3: Update `put_away_scans` SQL**

  Add:

  ```sql
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  verified_at TIMESTAMP,
  ```

- [ ] **Step 4: Remove `shipping_box_items` SQL**

  Delete the `CREATE TABLE IF NOT EXISTS shipping_box_items` block and its index.

- [ ] **Step 5: Remove `shelf_box_items` SQL**

  Delete the `CREATE TABLE IF NOT EXISTS shelf_box_items` block and its index.

- [ ] **Step 6: Verify types**

  Run: `pnpm nuxt prepare`
  Expected: succeeds.

---

## Task 3: Create mismatch helpers (`db/mismatch.ts`)

**Files:**
- Create: `db/mismatch.ts`
- Test: `tests/mismatch.test.ts`

- [ ] **Step 1: Move `computeReceivedQty` and `validateMismatchInputs`**

  Copy them from `db/receiving.ts` into `db/mismatch.ts`:

  ```ts
  import { eq, sql, inArray, and, ne, desc } from "drizzle-orm";
  import type { PgliteDatabase } from "drizzle-orm/pglite";
  import { v4 as uuid } from "uuid";
  import * as schema from "./schema";
  import { I18nError } from "~/composables/i18nError";

  export function computeReceivedQty(
    expectedQty: number,
    reason: schema.MismatchReason,
    mismatchQty: number | null
  ): number {
    switch (reason) {
      case "not_found":
        return 0;
      case "damaged":
      case "quality_rejection": {
        const bad = mismatchQty ?? 0;
        return Math.max(0, expectedQty - bad);
      }
      case "qty_mismatch": {
        return mismatchQty ?? 0;
      }
      case "over_shipment": {
        return expectedQty;
      }
      case "wrong_part":
        return 0;
      default:
        throw new I18nError("unhandled_mismatch_reason", { reason });
    }
  }

  export function validateMismatchInputs(
    expectedQty: number,
    reason: schema.MismatchReason | null,
    mismatchQty: number | null,
    wrongPartNo: string | null
  ): void {
    if (!reason) {
      throw new I18nError("mismatch_reason_required");
    }

    if (reason === "not_found" && mismatchQty !== null) {
      throw new I18nError("not_found_mismatch_cannot_include_qty");
    }

    const qty = mismatchQty ?? 0;

    if (!Number.isInteger(qty) || qty < 0) {
      throw new I18nError("quantity_must_be_non_negative_integer");
    }

    if (reason === "damaged" || reason === "quality_rejection") {
      if (qty > expectedQty) {
        throw new I18nError("damaged_rejected_quantity_exceeds_expected");
      }
    }

    if (reason === "over_shipment" || reason === "wrong_part") {
      if (qty <= 0) {
        throw new I18nError("quantity_must_be_greater_than_zero");
      }
    }

    if (reason === "wrong_part" && (!wrongPartNo || wrongPartNo.trim() === "")) {
      throw new I18nError("wrong_part_number_required");
    }

    if (reason === "qty_mismatch" && (mismatchQty === null || mismatchQty < 0)) {
      throw new I18nError("quantity_mismatch_requires_valid_received_qty");
    }

    const receivedQty = computeReceivedQty(expectedQty, reason, mismatchQty);
    if (receivedQty < 0) {
      throw new I18nError("computed_received_quantity_cannot_be_negative");
    }
  }
  ```

- [ ] **Step 2: Add guard helper**

  ```ts
  export async function assertCanApplyMismatchQty(
    dbOrTx: PgliteDatabase<typeof schema>,
    receivingInvoiceItemId: string,
    effectiveReceivedQty: number
  ): Promise<void> {
    const [item] = await dbOrTx
      .select({
        pickedQty: schema.receivingInvoiceItems.pickedQty,
        putAwayQty: schema.receivingInvoiceItems.putAwayQty,
      })
      .from(schema.receivingInvoiceItems)
      .where(eq(schema.receivingInvoiceItems.id, receivingInvoiceItemId));

    if (!item) throw new I18nError("receiving_invoice_item_not_found");

    const allocatedResult = await dbOrTx
      .select({
        total: sql<number>`coalesce(sum(${schema.allocations.qty}), 0)`.mapWith(Number),
      })
      .from(schema.allocations)
      .where(eq(schema.allocations.receivingInvoiceItemId, receivingInvoiceItemId));

    const allocated = allocatedResult[0]?.total ?? 0;
    const consumed = item.pickedQty + item.putAwayQty + allocated;

    if (effectiveReceivedQty < consumed) {
      throw new I18nError("mismatch_qty_below_consumed_stock");
    }
  }
  ```

- [ ] **Step 3: Add active-mismatch lookups**

  ```ts
  export async function getActiveMismatchForItem(
    db: PgliteDatabase<typeof schema>,
    receivingInvoiceItemId: string
  ): Promise<typeof schema.receivingItemMismatches.$inferSelect | null> {
    const [mismatch] = await db
      .select()
      .from(schema.receivingItemMismatches)
      .where(
        and(
          eq(schema.receivingItemMismatches.receivingInvoiceItemId, receivingInvoiceItemId),
          ne(schema.receivingItemMismatches.status, "cancelled")
        )
      )
      .orderBy(desc(schema.receivingItemMismatches.reportedAt))
      .limit(1);

    return mismatch ?? null;
  }

  export async function getActiveMismatchesForItems(
    db: PgliteDatabase<typeof schema>,
    receivingInvoiceItemIds: string[]
  ): Promise<Map<string, typeof schema.receivingItemMismatches.$inferSelect>> {
    const map = new Map<string, typeof schema.receivingItemMismatches.$inferSelect>();
    if (receivingInvoiceItemIds.length === 0) return map;

    const rows = await db
      .select()
      .from(schema.receivingItemMismatches)
      .where(
        and(
          inArray(schema.receivingItemMismatches.receivingInvoiceItemId, receivingInvoiceItemIds),
          ne(schema.receivingItemMismatches.status, "cancelled")
        )
      )
      .orderBy(desc(schema.receivingItemMismatches.reportedAt));

    for (const row of rows) {
      if (!map.has(row.receivingInvoiceItemId)) {
        map.set(row.receivingInvoiceItemId, row);
      }
    }
    return map;
  }
  ```

  Add `and`, `ne`, `desc` to the `drizzle-orm` import.

- [ ] **Step 4: Add report/edit/confirm/cancel functions**

  ```ts
  export async function reportReceivingItemMismatch(
    db: PgliteDatabase<typeof schema>,
    receivingInvoiceItemId: string,
    actorId: string,
    reason: schema.MismatchReason,
    mismatchQty: number | null,
    wrongPartNo: string | null,
    note: string
  ): Promise<void> {
    const trimmedWrongPartNo = wrongPartNo?.trim() || null;
    const trimmedNote = note.trim() || null;

    await db.transaction(async (tx) => {
      const item = await tx.query.receivingInvoiceItems.findFirst({
        where: eq(schema.receivingInvoiceItems.id, receivingInvoiceItemId),
      });
      if (!item) throw new I18nError("receiving_invoice_item_not_found");

      const existing = await getActiveMismatchForItem(tx, receivingInvoiceItemId);
      if (existing?.status === "confirmed") {
        throw new I18nError("confirmed_mismatch_already_exists");
      }
      if (existing) {
        throw new I18nError("pending_mismatch_already_exists");
      }

      validateMismatchInputs(item.qty, reason, mismatchQty, trimmedWrongPartNo);
      const effectiveReceivedQty = computeReceivedQty(item.qty, reason, mismatchQty);
      await assertCanApplyMismatchQty(tx, receivingInvoiceItemId, effectiveReceivedQty);

      const now = new Date();
      await tx.insert(schema.receivingItemMismatches).values({
        id: uuid(),
        receivingInvoiceItemId,
        reason,
        mismatchQty: reason !== "not_found" ? mismatchQty : null,
        wrongPartNo: reason === "wrong_part" ? trimmedWrongPartNo : null,
        note: trimmedNote,
        status: "pending",
        effectiveReceivedQty,
        previousReceivedQty: item.receivedQty,
        reportedBy: actorId,
        reportedAt: now,
      });

      await tx
        .update(schema.receivingInvoiceItems)
        .set({ receivedQty: effectiveReceivedQty })
        .where(eq(schema.receivingInvoiceItems.id, receivingInvoiceItemId));

      await tx.insert(schema.transitionLogs).values({
        id: uuid(),
        entityType: "receiving_item_mismatch",
        entityId: receivingInvoiceItemId,
        fromState: null,
        toState: "pending",
        actorId,
        metadata: JSON.stringify({ reason, mismatchQty, wrongPartNo: trimmedWrongPartNo, effectiveReceivedQty, note: trimmedNote }),
        createdAt: now,
      });
    });
  }

  export async function editReceivingItemMismatch(
    db: PgliteDatabase<typeof schema>,
    mismatchId: string,
    actorId: string,
    reason: schema.MismatchReason,
    mismatchQty: number | null,
    wrongPartNo: string | null,
    note: string
  ): Promise<void> {
    const trimmedWrongPartNo = wrongPartNo?.trim() || null;
    const trimmedNote = note.trim() || null;

    await db.transaction(async (tx) => {
      const mismatch = await tx.query.receivingItemMismatches.findFirst({
        where: eq(schema.receivingItemMismatches.id, mismatchId),
      });
      if (!mismatch) throw new I18nError("receiving_item_mismatch_not_found");
      if (mismatch.status !== "pending") throw new I18nError("only_pending_mismatch_can_be_edited");
      if (mismatch.reportedBy !== actorId) throw new I18nError("only_reporter_can_edit_mismatch");

      const item = await tx.query.receivingInvoiceItems.findFirst({
        where: eq(schema.receivingInvoiceItems.id, mismatch.receivingInvoiceItemId),
      });
      if (!item) throw new I18nError("receiving_invoice_item_not_found");

      validateMismatchInputs(item.qty, reason, mismatchQty, trimmedWrongPartNo);
      const effectiveReceivedQty = computeReceivedQty(item.qty, reason, mismatchQty);
      await assertCanApplyMismatchQty(tx, mismatch.receivingInvoiceItemId, effectiveReceivedQty);

      const now = new Date();
      await tx
        .update(schema.receivingItemMismatches)
        .set({
          reason,
          mismatchQty: reason !== "not_found" ? mismatchQty : null,
          wrongPartNo: reason === "wrong_part" ? trimmedWrongPartNo : null,
          note: trimmedNote,
          effectiveReceivedQty,
        })
        .where(eq(schema.receivingItemMismatches.id, mismatchId));

      await tx
        .update(schema.receivingInvoiceItems)
        .set({ receivedQty: effectiveReceivedQty })
        .where(eq(schema.receivingInvoiceItems.id, mismatch.receivingInvoiceItemId));

      await tx.insert(schema.transitionLogs).values({
        id: uuid(),
        entityType: "receiving_item_mismatch",
        entityId: mismatch.receivingInvoiceItemId,
        fromState: "pending",
        toState: "pending",
        actorId,
        metadata: JSON.stringify({ reason, mismatchQty, wrongPartNo: trimmedWrongPartNo, effectiveReceivedQty, note: trimmedNote }),
        createdAt: now,
      });
    });
  }

  export async function confirmReceivingItemMismatch(
    db: PgliteDatabase<typeof schema>,
    mismatchId: string,
    actorId: string
  ): Promise<void> {
    await db.transaction(async (tx) => {
      const mismatch = await tx.query.receivingItemMismatches.findFirst({
        where: eq(schema.receivingItemMismatches.id, mismatchId),
      });
      if (!mismatch) throw new I18nError("receiving_item_mismatch_not_found");
      if (mismatch.status !== "pending") throw new I18nError("only_pending_mismatch_can_be_confirmed");
      if (mismatch.reportedBy === actorId) throw new I18nError("reporter_cannot_confirm_own_mismatch");

      const now = new Date();
      await tx
        .update(schema.receivingItemMismatches)
        .set({ status: "confirmed", confirmedBy: actorId, confirmedAt: now })
        .where(eq(schema.receivingItemMismatches.id, mismatchId));

      await tx.insert(schema.transitionLogs).values({
        id: uuid(),
        entityType: "receiving_item_mismatch",
        entityId: mismatch.receivingInvoiceItemId,
        fromState: "pending",
        toState: "confirmed",
        actorId,
        metadata: JSON.stringify({ mismatchId }),
        createdAt: now,
      });
    });
  }

  export async function cancelReceivingItemMismatch(
    db: PgliteDatabase<typeof schema>,
    mismatchId: string,
    actorId: string
  ): Promise<void> {
    await db.transaction(async (tx) => {
      const mismatch = await tx.query.receivingItemMismatches.findFirst({
        where: eq(schema.receivingItemMismatches.id, mismatchId),
      });
      if (!mismatch) throw new I18nError("receiving_item_mismatch_not_found");
      if (mismatch.status !== "pending") throw new I18nError("only_pending_mismatch_can_be_cancelled");
      if (mismatch.reportedBy === actorId) throw new I18nError("reporter_cannot_cancel_own_mismatch");

      await assertCanApplyMismatchQty(tx, mismatch.receivingInvoiceItemId, mismatch.previousReceivedQty);

      const item = await tx.query.receivingInvoiceItems.findFirst({
        where: eq(schema.receivingInvoiceItems.id, mismatch.receivingInvoiceItemId),
      });
      if (!item) throw new I18nError("receiving_invoice_item_not_found");

      const now = new Date();
      await tx
        .update(schema.receivingItemMismatches)
        .set({ status: "cancelled", cancelledBy: actorId, cancelledAt: now })
        .where(eq(schema.receivingItemMismatches.id, mismatchId));

      await tx
        .update(schema.receivingInvoiceItems)
        .set({ receivedQty: mismatch.previousReceivedQty })
        .where(eq(schema.receivingInvoiceItems.id, mismatch.receivingInvoiceItemId));

      await tx.insert(schema.transitionLogs).values({
        id: uuid(),
        entityType: "receiving_item_mismatch",
        entityId: mismatch.receivingInvoiceItemId,
        fromState: "pending",
        toState: "cancelled",
        actorId,
        metadata: JSON.stringify({ mismatchId, revertedToQty: mismatch.previousReceivedQty }),
        createdAt: now,
      });
    });
  }
  ```

- [ ] **Step 5: Write the first failing test**

  Create `tests/mismatch.test.ts`:

  ```ts
  import { describe, it, expect, beforeEach } from 'vitest';
  import { eq } from 'drizzle-orm';
  import { PGlite } from '@electric-sql/pglite';
  import { drizzle } from 'drizzle-orm/pglite';
  import { v4 as uuid } from 'uuid';
  import * as schema from '../db/schema';
  import { createTablesSql } from '../db/init';
  import {
    reportReceivingItemMismatch,
    confirmReceivingItemMismatch,
    cancelReceivingItemMismatch,
    getActiveMismatchForItem,
  } from '../db/mismatch';
  import { I18nError } from '../composables/i18nError';

  async function createTestDb() {
    const pg = new PGlite();
    await pg.waitReady;
    await pg.exec(createTablesSql);
    return drizzle(pg, { schema });
  }

  async function seedUserSupplierPart(db: Awaited<ReturnType<typeof createTestDb>>) {
    const now = new Date();
    const actorId = uuid();
    await db.insert(schema.users).values({
      id: actorId,
      username: 'operator',
      passwordHash: 'pw',
      displayName: 'Operator',
      role: 'operator',
      createdAt: now,
    });

    const otherActorId = uuid();
    await db.insert(schema.users).values({
      id: otherActorId,
      username: 'other',
      passwordHash: 'pw',
      displayName: 'Other',
      role: 'operator',
      createdAt: now,
    });

    const supplierId = uuid();
    await db.insert(schema.suppliers).values({ id: supplierId, code: 'KOA', name: 'KOA' });

    const partId = uuid();
    await db.insert(schema.parts).values({
      id: partId,
      partNo: 'RK73B1JTTD181G',
      internalCode: '',
      description: '',
      defaultCoo: 'CN',
    });

    return { actorId, otherActorId, supplierId, partId };
  }

  async function createReceivingItem(db: Awaited<ReturnType<typeof createTestDb>>, partId: string, qty: number) {
    const now = new Date();
    const orderId = uuid();
    await db.insert(schema.receivingOrders).values({
      id: orderId,
      refNo: 'RO-001',
      status: 'in_hand',
      createdAt: now,
      updatedAt: now,
    });

    const invoiceId = uuid();
    await db.insert(schema.receivingInvoices).values({
      id: invoiceId,
      receivingOrderId: orderId,
      invoiceNo: 'INV-001',
    });

    const itemId = uuid();
    await db.insert(schema.receivingInvoiceItems).values({
      id: itemId,
      receivingInvoiceId: invoiceId,
      partId,
      qty,
      receivedQty: qty,
      pickedQty: 0,
      putAwayQty: 0,
    });

    return itemId;
  }

  describe('receiving item mismatch', () => {
    let db: Awaited<ReturnType<typeof createTestDb>>;
    let actorId: string;
    let otherActorId: string;
    let partId: string;

    beforeEach(async () => {
      db = await createTestDb();
      const seeded = await seedUserSupplierPart(db);
      actorId = seeded.actorId;
      otherActorId = seeded.otherActorId;
      partId = seeded.partId;
    });

    it('reports a pending mismatch and updates received_qty', async () => {
      const itemId = await createReceivingItem(db, partId, 100);
      await reportReceivingItemMismatch(db, itemId, actorId, 'damaged', 30, null, 'box crushed');

      const mismatch = await getActiveMismatchForItem(db, itemId);
      expect(mismatch?.status).toBe('pending');
      expect(mismatch?.effectiveReceivedQty).toBe(70);

      const item = await db.query.receivingInvoiceItems.findFirst({
        where: eq(schema.receivingInvoiceItems.id, itemId),
      });
      expect(item?.receivedQty).toBe(70);
    });

    it('confirms a pending mismatch', async () => {
      const itemId = await createReceivingItem(db, partId, 100);
      await reportReceivingItemMismatch(db, itemId, actorId, 'damaged', 30, null, '');
      const mismatch = await getActiveMismatchForItem(db, itemId);
      await confirmReceivingItemMismatch(db, mismatch!.id, otherActorId);

      const updated = await getActiveMismatchForItem(db, itemId);
      expect(updated?.status).toBe('confirmed');
    });

    it('prevents reporter from confirming their own mismatch', async () => {
      const itemId = await createReceivingItem(db, partId, 100);
      await reportReceivingItemMismatch(db, itemId, actorId, 'damaged', 30, null, '');
      const mismatch = await getActiveMismatchForItem(db, itemId);
      await expect(confirmReceivingItemMismatch(db, mismatch!.id, actorId)).rejects.toThrow(I18nError);
    });

    it('cancels a pending mismatch and reverts received_qty', async () => {
      const itemId = await createReceivingItem(db, partId, 100);
      await reportReceivingItemMismatch(db, itemId, actorId, 'damaged', 30, null, '');
      const mismatch = await getActiveMismatchForItem(db, itemId);
      await cancelReceivingItemMismatch(db, mismatch!.id, otherActorId);

      const item = await db.query.receivingInvoiceItems.findFirst({
        where: eq(schema.receivingInvoiceItems.id, itemId),
      });
      expect(item?.receivedQty).toBe(100);
      expect(await getActiveMismatchForItem(db, itemId)).toBeNull();
    });

    it('blocks cancellation when stock is already consumed beyond effective qty', async () => {
      const itemId = await createReceivingItem(db, partId, 100);
      await reportReceivingItemMismatch(db, itemId, actorId, 'damaged', 30, null, '');
      await db.update(schema.receivingInvoiceItems).set({ pickedQty: 80 }).where(eq(schema.receivingInvoiceItems.id, itemId));
      const mismatch = await getActiveMismatchForItem(db, itemId);
      await expect(cancelReceivingItemMismatch(db, mismatch!.id, otherActorId)).rejects.toThrow(I18nError);
    });
  });
  ```

- [ ] **Step 6: Run the mismatch tests**

  Run: `pnpm vitest run tests/mismatch.test.ts`
  Expected: tests pass after helpers are implemented.

---

## Task 4: Update receiving helpers (`db/receiving.ts`)

**Files:**
- Modify: `db/receiving.ts`
- Test: `pnpm vitest run tests/mismatch.test.ts`, manual browser check

- [ ] **Step 1: Remove old mismatch exports**

  Delete `computeReceivedQty`, `validateMismatchInputs`, `canEditReceivingItemMismatch`, and `updateReceivingItemMismatch` from `db/receiving.ts`.

- [ ] **Step 2: Update imports**

  Add:

  ```ts
  import { getActiveMismatchesForItems } from "./mismatch";
  ```

- [ ] **Step 3: Update `confirmReceivingOrderArrived`**

  Replace the inner item loop with:

  ```ts
  const itemIds = order.invoices.flatMap((inv) => inv.items.map((i) => i.id));
  const activeMismatches = await getActiveMismatchesForItems(tx, itemIds);

  for (const invoice of order.invoices) {
    for (const item of invoice.items) {
      const mismatch = activeMismatches.get(item.id);
      const qtyToReceive = mismatch ? mismatch.effectiveReceivedQty : item.qty;
      if (qtyToReceive <= 0) continue;

      await tx
        .update(schema.receivingInvoiceItems)
        .set({ receivedQty: qtyToReceive })
        .where(eq(schema.receivingInvoiceItems.id, item.id));
    }
  }
  ```

- [ ] **Step 4: Verify build**

  Run: `pnpm nuxt prepare`
  Expected: succeeds.

---

## Task 5: Remove `shipping_box_items` usage (`db/picking.ts`)

**Files:**
- Modify: `db/picking.ts`
- Test: `pnpm vitest run tests/picking.test.ts`

- [ ] **Step 1: Remove `shippingBoxItems` check from `cancelShippingBox`**

  Delete these lines in `cancelShippingBox`:

  ```ts
  const itemResult = await tx
    .select({ count: sql<number>`count(*)`.mapWith(Number) })
    .from(schema.shippingBoxItems)
    .where(eq(schema.shippingBoxItems.shippingBoxId, boxId));
  if (itemResult[0]?.count > 0) throw new I18nError("box_is_not_empty");
  ```

- [ ] **Step 2: Remove `shippingBoxItems` from `getPickingOrderDetail` relations if present**

  It is not present, so nothing to do.

- [ ] **Step 3: Run picking tests**

  Run: `pnpm vitest run tests/picking.test.ts`
  Expected: passes.

---

## Task 6: Merge `shelf_box_items` into `put_away_scans` (`db/putAway.ts`)

**Files:**
- Modify: `db/putAway.ts`
- Test: `pnpm vitest run tests/putAway.test.ts`

- [ ] **Step 1: Remove `shelfBoxItems` writes in `assignScanToBox`**

  Delete the `summary` lookup and the `shelfBoxItems` insert/update block at the end of `assignScanToBox`.

- [ ] **Step 2: Clear verified state in `removeScanFromBox`**

  After decrementing `inventory_lot_sources`, add:

  ```ts
  await tx
    .update(schema.putAwayScans)
    .set({ verified: false, verifiedAt: null })
    .where(eq(schema.putAwayScans.id, scanId));
  ```

  Delete the `summary` lookup and the `shelfBoxItems` delete/update block.

- [ ] **Step 3: Update `getShelfBoxesForReceivingOrder`**

  Replace the Drizzle query with a query that loads boxes and aggregates scan items per box:

  ```ts
  export async function getShelfBoxesForReceivingOrder(
    db: PgliteDatabase<typeof schema>,
    receivingOrderId: string
  ) {
    const boxes = await db.query.shelfBoxes.findMany({
      where: eq(schema.shelfBoxes.receivingOrderId, receivingOrderId),
      orderBy: (sb, { sql }) => [
        sql`case when ${sb.status} = 'open' then 0 else 1 end`,
        desc(sb.createdAt),
      ],
    });

    if (boxes.length === 0) return [];

    const boxIds = boxes.map((b) => b.id);
    const idList = boxIds.map((id) => `'${id}'`).join(", ");

    const itemsResult = await db.execute(sql`
      SELECT
        pas.shelf_box_id AS shelf_box_id,
        pas.part_id AS part_id,
        p.part_no,
        SUM(pas.qty) AS qty,
        bool_and(pas.verified) AS verified
      FROM put_away_scans pas
      JOIN parts p ON p.id = pas.part_id
      WHERE pas.shelf_box_id IN (${sql.raw(idList)})
      GROUP BY pas.shelf_box_id, pas.part_id, p.part_no
    `);

    const itemsByBox = new Map<
      string,
      { id: string; partId: string; part: { partNo: string | null }; qty: number; verified: boolean }[]
    >();

    for (const row of (itemsResult.rows ?? []) as any[]) {
      const boxId = String(row.shelf_box_id);
      const list = itemsByBox.get(boxId) ?? [];
      list.push({
        id: `${boxId}-${row.part_id}`,
        partId: String(row.part_id),
        part: { partNo: row.part_no as string | null },
        qty: Number(row.qty ?? 0),
        verified: Boolean(row.verified),
      });
      itemsByBox.set(boxId, list);
    }

    return boxes.map((box) => ({
      ...box,
      items: itemsByBox.get(box.id) ?? [],
    }));
  }
  ```

  The return shape stays compatible with `components/put-away/ShelfBoxesPanel.vue`, which reads `box.items`, `item.part?.partNo`, and `item.qty`.

- [ ] **Step 4: Update tests**

  Update `tests/putAway.test.ts` to remove `shelfBoxItems` assertions and add `putAwayScans.verified` checks where relevant.

- [ ] **Step 5: Run put-away tests**

  Run: `pnpm vitest run tests/putAway.test.ts`
  Expected: passes.

---

## Task 7: Update goods verify helpers (`db/goodsVerify.ts`)

**Files:**
- Modify: `db/goodsVerify.ts`
- Test: `pnpm vitest run tests/putAway.test.ts`, manual browser check

- [ ] **Step 1: Update `getShelfBoxesByShelf`**

  Replace the query with the CTE version from the spec:

  ```ts
  const result = await db.execute(sql`
    WITH box_items AS (
      SELECT shelf_box_id, part_id, bool_and(verified) AS fully_verified
      FROM put_away_scans
      GROUP BY shelf_box_id, part_id
    ),
    last_checks AS (
      SELECT shelf_box_id, MAX(verified_at) AS last_check_at
      FROM put_away_scans
      GROUP BY shelf_box_id
    )
    SELECT
      sb.id,
      sb.shelf_code,
      sb.status,
      sb.created_at,
      COUNT(bi.part_id) AS item_count,
      COUNT(CASE WHEN bi.fully_verified THEN 1 END) AS verified_count,
      lc.last_check_at
    FROM shelf_boxes sb
    LEFT JOIN box_items bi ON bi.shelf_box_id = sb.id
    LEFT JOIN last_checks lc ON lc.shelf_box_id = sb.id
    WHERE sb.shelf_code = ${shelfCode}
    GROUP BY sb.id, sb.shelf_code, sb.status, sb.created_at, lc.last_check_at
  `);
  ```

- [ ] **Step 2: Update `getShelfBoxDetail`**

  Replace the Drizzle query with a raw query:

  ```ts
  const box = await db.query.shelfBoxes.findFirst({
    where: eq(schema.shelfBoxes.id, shelfBoxId),
    with: {
      shelf: true,
      receivingOrder: { columns: { id: true, refNo: true } },
    },
  });
  if (!box) return null;

  const itemsResult = await db.execute(sql`
    SELECT
      part_id AS partId,
      SUM(qty) AS qty,
      bool_and(verified) AS verified,
      MAX(verified_at) AS verifiedAt
    FROM put_away_scans
    WHERE shelf_box_id = ${shelfBoxId}
    GROUP BY part_id
  `);

  const items = await Promise.all(
    (itemsResult.rows ?? []).map(async (row) => {
      const part = await db.query.parts.findFirst({
        where: eq(schema.parts.id, String(row.partId)),
        columns: { id: true, partNo: true, description: true },
      });
      return {
        id: `${shelfBoxId}-${row.partId}`,
        shelfBoxId,
        receivingInvoiceItemId: null,
        partId: String(row.partId),
        qty: Number(row.qty ?? 0),
        verified: Boolean(row.verified),
        verifiedAt: row.verifiedAt ? new Date(String(row.verifiedAt)) : null,
        part: part ?? null,
      };
    })
  );

  return {
    ...box,
    shelf: box.shelf ?? null,
    receivingOrder: box.receivingOrder ?? null,
    items,
  };
  ```

  Update the `ShelfBoxItemDetail` interface: `id` can be the generated composite id.

- [ ] **Step 3: Replace `verifyShelfBoxItem` with `verifyShelfBoxScans`**

  ```ts
  export async function verifyShelfBoxScans(
    db: PgliteDatabase<typeof schema>,
    shelfBoxId: string,
    partId: string
  ): Promise<void> {
    await db
      .update(schema.putAwayScans)
      .set({ verified: true, verifiedAt: new Date() })
      .where(
        and(
          eq(schema.putAwayScans.shelfBoxId, shelfBoxId),
          eq(schema.putAwayScans.partId, partId)
        )
      );
  }
  ```

- [ ] **Step 4: Update `markShelfBoxVerified`**

  Replace the `box.items.every(...)` check with:

  ```ts
  const scans = await tx.query.putAwayScans.findMany({
    where: eq(schema.putAwayScans.shelfBoxId, shelfBoxId),
  });
  if (scans.length === 0) throw new I18nError("shelf_box_has_no_items");
  const allVerified = scans.every((scan) => scan.verified);
  if (!allVerified) throw new I18nError("not_all_shelf_box_items_verified");
  ```

- [ ] **Step 5: Update `composables/useScanMatchers.ts`**

  Change the import from `verifyShelfBoxItem` to `verifyShelfBoxScans` and update `matchGoodsVerify`:

  ```ts
  import { verifyShelfBoxScans } from '~/db/goodsVerify';

  // inside matchGoodsVerify
  apply: () => verifyShelfBoxScans(db, item.shelfBoxId, item.partId),
  ```

- [ ] **Step 6: Run tests**

  Run: `pnpm vitest run tests/putAway.test.ts`
  Expected: passes.

---

## Task 8: Update seed data (`db/seed.ts`)

**Files:**
- Modify: `db/seed.ts`
- Test: `pnpm dev` and reload the app

- [ ] **Step 1: Remove mismatch columns from seed rows**

  Delete `reportedMismatch` and `mismatchNote` from all `receivingInvoiceItemRecords` rows.

- [ ] **Step 2: Replace `shelfBoxItems` seed with `putAwayScans`**

  Delete the entire `db.insert(schema.shelfBoxItems).values([...])` block and replace it with `putAwayScans` rows that represent the same physical box contents:

  ```ts
  await db.insert(schema.putAwayScans).values([
    { id: uuid(), shelfBoxId: "SBOX-SEED-001", receivingInvoiceItemId: null, partId: partByNo["RK73B1JTTD181G"].id, qty: 1000, dateCode: "", lotCode: "", coo: "CN", cow: "USA", verified: false, verifiedAt: null, createdAt: now },
    { id: uuid(), shelfBoxId: "SBOX-SEED-001", receivingInvoiceItemId: null, partId: partByNo["RK73H2ATTD1372F"].id, qty: 500, dateCode: "", lotCode: "", coo: "CN", cow: "USA", verified: true, verifiedAt: now, createdAt: now },
    { id: uuid(), shelfBoxId: "SBOX-SEED-002", receivingInvoiceItemId: null, partId: partByNo["S-1206B18-M3T1U"].id, qty: 500, dateCode: "", lotCode: "", coo: "JP", cow: "USA", verified: true, verifiedAt: now, createdAt: now },
    { id: uuid(), shelfBoxId: "SBOX-SEED-003", receivingInvoiceItemId: null, partId: partByNo["S-8240ADJ-I6T1U"].id, qty: 200, dateCode: "", lotCode: "", coo: "JP", cow: "USA", verified: false, verifiedAt: null, createdAt: now },
    { id: uuid(), shelfBoxId: "SBOX-SEED-003", receivingInvoiceItemId: null, partId: partByNo["D1FL20U"].id, qty: 100, dateCode: "", lotCode: "", coo: "JP", cow: "USA", verified: false, verifiedAt: null, createdAt: now },
  ]);
  ```

  Note: these scans do not need corresponding `inventory_lots` rows because they represent pre-existing shelf stock, not stock received through the put-away flow.

- [ ] **Step 3: Optionally seed sample mismatches**

  After inserting `receivingInvoiceItemRecords`, insert one pending and one confirmed mismatch for manual testing:

  ```ts
  const [sampleItem] = receivingInvoiceItemRecords;
  const [sampleItem2] = receivingInvoiceItemRecords.slice(1);

  await db.insert(schema.receivingItemMismatches).values([
    {
      id: uuid(),
      receivingInvoiceItemId: sampleItem.id,
      reason: "damaged",
      mismatchQty: 100,
      wrongPartNo: null,
      note: "Seeded pending mismatch",
      status: "pending",
      effectiveReceivedQty: sampleItem.qty - 100,
      previousReceivedQty: sampleItem.qty,
      reportedBy: userOperator.id,
      reportedAt: now,
    },
    {
      id: uuid(),
      receivingInvoiceItemId: sampleItem2.id,
      reason: "qty_mismatch",
      mismatchQty: 1000,
      wrongPartNo: null,
      note: "Seeded confirmed mismatch",
      status: "confirmed",
      effectiveReceivedQty: 1000,
      previousReceivedQty: sampleItem2.qty,
      reportedBy: userOperator.id,
      reportedAt: now,
      confirmedBy: userAdmin.id,
      confirmedAt: now,
    },
  ]);
  ```

  Also update the matching `receivedQty` values on those seeded items to match `effectiveReceivedQty`.

- [ ] **Step 4: Verify seed runs**

  Run: `pnpm dev`
  Expected: app loads without seed errors.

---

## Task 9: Update receiving UI types and components

**Files:**
- Modify: `components/receiving/types.ts`
- Modify: `components/receiving/ReceivingItemsTab.vue`
- Modify: `components/ReportIssueModal.vue`
- Modify: `pages/receiving/[id].vue`
- Test: manual browser check

- [ ] **Step 1: Update `DisplayReceivingItem`**

  In `components/receiving/types.ts`:

  ```ts
  export type DisplayReceivingItem = typeof schema.receivingInvoiceItems.$inferSelect & {
    part?: typeof schema.parts.$inferSelect | null;
    mismatch?: typeof schema.receivingItemMismatches.$inferSelect & {
      reportedByUser?: typeof schema.users.$inferSelect | null;
      confirmedByUser?: typeof schema.users.$inferSelect | null;
    } | null;
  };
  ```

- [ ] **Step 2: Load active mismatches in receiving detail**

  In `pages/receiving/[id].vue`, after loading the order, fetch active mismatches for all item IDs and merge them into `DisplayReceivingItem`:

  ```ts
  import { getActiveMismatchesForItems } from "~/db/mismatch";

  // inside load()
  const allItemIds = orderData.invoices.flatMap((inv) => inv.items.map((i) => i.id));
  const activeMismatches = await getActiveMismatchesForItems(db, allItemIds);

  order.value = {
    ...orderData,
    invoices: orderData.invoices.map((invoice) => ({
      ...invoice,
      items: invoice.items.map((item) => ({
        ...item,
        mismatch: activeMismatches.get(item.id) ?? null,
      })) as DisplayReceivingItem[],
    })),
  };
  ```

- [ ] **Step 3: Wire confirm/cancel handlers**

  Add imports and handlers in `pages/receiving/[id].vue`:

  ```ts
  import {
    confirmReceivingItemMismatch,
    cancelReceivingItemMismatch,
  } from "~/db/mismatch";

  async function confirmMismatch(mismatchId: string) {
    if (!currentUser.value) return;
    saving.value[mismatchId] = true;
    try {
      await confirmReceivingItemMismatch(db, mismatchId, currentUser.value.id);
      await load();
    } catch (e: any) {
      error.value = errorMessage(e);
    } finally {
      saving.value[mismatchId] = false;
    }
  }

  async function cancelMismatch(mismatchId: string) {
    if (!currentUser.value) return;
    saving.value[mismatchId] = true;
    try {
      await cancelReceivingItemMismatch(db, mismatchId, currentUser.value.id);
      await load();
    } catch (e: any) {
      error.value = errorMessage(e);
    } finally {
      saving.value[mismatchId] = false;
    }
  }
  ```

  Pass these handlers to `ReceivingItemsTab`.

- [ ] **Step 4: Update `ReceivingItemsTab.vue`**

  Update the template to:
  - Show mismatch status badge when `item.mismatch` exists.
  - Show Confirm/Cancel buttons when `item.mismatch.status === 'pending'` and current user is not the reporter.
  - Show Edit button when pending and current user is the reporter.
  - Keep Report issue button when no mismatch.
  - Remove `card--mismatch` class logic based on `reportedMismatch`.

  Update `formatMismatchSummary` to use `item.mismatch.reason`, `item.mismatch.mismatchQty`, `item.mismatch.wrongPartNo`.

- [ ] **Step 5: Update `ReportIssueModal.vue`**

  - Import helpers from `db/mismatch` instead of `db/receiving`.
  - Remove the empty "—" option from the reason selector. Cancelling a pending mismatch is now a separate action, not a reason choice.
  - Pre-fill from `item.mismatch` when editing.
  - Emit `confirm` with a flag indicating report vs edit.

- [ ] **Step 6: Update `pages/receiving/[id].vue` `onConfirmIssue`**

  Use `reportReceivingItemMismatch` for new reports and `editReceivingItemMismatch` for edits based on whether `reportModalItem.value.mismatch` exists.

- [ ] **Step 7: Run type check**

  Run: `pnpm nuxt prepare`
  Expected: succeeds.

---

## Task 10: Add i18n strings

**Files:**
- Modify: `i18n/locales/en-US.json`
- Modify: `i18n/locales/zh-CN.json`
- Modify: `i18n/locales/zh-HK.json`

- [ ] **Step 1: Add English strings**

  Add under `receiving.itemsTab`:

  ```json
  "mismatchStatus": {
    "pending": "Pending confirmation",
    "confirmed": "Confirmed",
    "cancelled": "Cancelled"
  },
  "confirmMismatch": "Confirm",
  "cancelMismatch": "Cancel"
  ```

- [ ] **Step 2: Add error strings**

  Add under `errors` or equivalent:

  ```json
  "confirmed_mismatch_already_exists": "A confirmed mismatch already exists for this item.",
  "pending_mismatch_already_exists": "A pending mismatch already exists for this item.",
  "only_pending_mismatch_can_be_edited": "Only a pending mismatch can be edited.",
  "only_reporter_can_edit_mismatch": "Only the reporter can edit this mismatch.",
  "only_pending_mismatch_can_be_confirmed": "Only a pending mismatch can be confirmed.",
  "only_pending_mismatch_can_be_cancelled": "Only a pending mismatch can be cancelled.",
  "reporter_cannot_confirm_own_mismatch": "You cannot confirm your own mismatch report.",
  "reporter_cannot_cancel_own_mismatch": "You cannot cancel your own mismatch report.",
  "mismatch_qty_below_consumed_stock": "This action would reduce available stock below already-allocated or picked quantity.",
  "mismatch_reason_required": "Please select a mismatch reason."
  ```

- [ ] **Step 3: Add Chinese translations**

  Add equivalent strings to `zh-CN.json` and `zh-HK.json`. Use simple Chinese for `zh-CN` and traditional Chinese for `zh-HK`.

---

## Task 11: Final verification

**Files:** all modified files

- [ ] **Step 1: Run type generation**

  Run: `pnpm nuxt prepare`
  Expected: succeeds.

- [ ] **Step 2: Run unit tests**

  Run: `pnpm vitest run`
  Expected: all tests pass.

- [ ] **Step 3: Run Android unit tests**

  Run:

  ```bash
  cd android
  export JAVA_HOME='/c/Program Files/Android/Android Studio/jbr'
  export PATH="$JAVA_HOME/bin:$PATH"
  ./gradlew :app:testDebugUnitTest
  ```

  Expected: passes (no Java changes).

- [ ] **Step 4: Manual browser test**

  Run: `pnpm dev`
  Log in as `operator` / `DocPal2026!`.
  - Open a receiving order.
  - Report a mismatch; verify badge shows "Pending confirmation" and received quantity changes.
  - Log in as `admin` / `DocPalAdmin2026!`.
  - Confirm the mismatch; verify badge shows "Confirmed".
  - Report another mismatch, allocate the reduced stock via a picking order, then try to cancel and verify it is blocked.
  - Open put-away, scan items to a shelf box, then open goods verify and verify the items.

---

## Self-review

### Spec coverage

| Spec requirement | Plan task |
|------------------|-----------|
| Dedicated `receiving_item_mismatches` table | Task 1, Task 2 |
| Remove mismatch columns from `receiving_invoice_items` | Task 1, Task 2 |
| Pending reduces effective qty immediately | Task 3 (report/edit update `receivedQty`) |
| Confirmed is final | Task 3 (`confirmReceivingItemMismatch` sets status only) |
| Cancel reverts qty | Task 3 (`cancelReceivingItemMismatch` updates `receivedQty` to `item.qty`) |
| Reporter cannot confirm/cancel | Task 3 (actor checks) |
| Guards on report/edit/cancel | Task 3 (`assertCanApplyMismatchQty`) |
| Remove `shipping_box_items` | Task 1, Task 2, Task 5 |
| Merge `shelf_box_items` into `put_away_scans` | Task 1, Task 2, Task 6, Task 7 |
| Audit via `transition_logs` | Task 3 (inserts on every transition) |
| UI shows status and actions | Task 9 |
| i18n strings | Task 10 |
| Tests | Task 3, Task 5, Task 6, Task 7, Task 11 |

### Placeholder scan

- No "TBD", "TODO", or "implement later".
- All code snippets are concrete.
- All commands include expected output.
- Function signatures are consistent across tasks.

### Type consistency

- `receivingItemMismatches` table name and column names match in schema, init, helpers, and UI.
- `MismatchReason` and `mismatchStatuses` enums reused from `db/schema.ts`.
- `DisplayReceivingItem.mismatch` type matches the selected columns.
