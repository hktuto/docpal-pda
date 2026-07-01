# Receiving List — Pending Picking Order Count Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reactive badge to each receiving-order card on the receiving list page that shows how many distinct picking orders still need items from that receiving order.

**Architecture:** Compute the count in the existing SQL query behind `pages/receiving/index.vue` using a scalar correlated subquery that counts distinct `picking_orders.id` through `allocations` and `picking_items`. Render the result as a small badge next to the existing status/remaining badges.

**Tech Stack:** Nuxt 3, Vue 3, TypeScript, PGlite, `useLiveQuery` from `@electric-sql/pglite-vue`.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `pages/receiving/index.vue` | Existing receiving list page. Adds `pending_picking_orders` to the SQL query, to the TypeScript row interface, and renders it as a badge in the template. |

---

### Task 1: Add pending picking order count to receiving list

**Files:**
- Modify: `pages/receiving/index.vue`

- [ ] **Step 1: Add `pending_picking_orders` to the TypeScript interface**

In `pages/receiving/index.vue`, update the `ReceivingOrderRow` interface:

```ts
interface ReceivingOrderRow {
  id: string;
  ref_no: string;
  status: string;
  delivery_date: string | null;
  supplier_name: string | null;
  remaining_qty: number;
  pending_picking_orders: number;
}
```

- [ ] **Step 2: Extend the SQL query to compute the count**

Add a scalar subquery column to the `SELECT` clause in the existing `query` computed:

```ts
  return `SELECT
    ro.id,
    ro.ref_no,
    ro.status,
    ro.delivery_date,
    s.name AS supplier_name,
    COALESCE(SUM(
      CASE
        WHEN ro.status = 'in_hand'
        THEN rii.received_qty - rii.picked_qty - rii.put_away_qty -
             COALESCE(alloc.allocated_qty, 0)
        ELSE 0
      END
    ), 0) AS remaining_qty,
    COALESCE((
      SELECT COUNT(DISTINCT pi.picking_order_id)
      FROM allocations a
      JOIN picking_items pi ON pi.id = a.picking_item_id
      WHERE a.receiving_invoice_item_id IN (
        SELECT rii2.id
        FROM receiving_invoices ri2
        JOIN receiving_invoice_items rii2 ON rii2.receiving_invoice_id = ri2.id
        WHERE ri2.receiving_order_id = ro.id
      )
      AND a.qty > pi.picked_qty
    ), 0) AS pending_picking_orders
  FROM receiving_orders ro
  LEFT JOIN suppliers s ON s.id = ro.supplier_id
  LEFT JOIN receiving_invoices ri ON ri.receiving_order_id = ro.id
  LEFT JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
  LEFT JOIN (
    SELECT receiving_invoice_item_id, SUM(qty) AS allocated_qty
    FROM allocations
    WHERE receiving_invoice_item_id IS NOT NULL
    GROUP BY receiving_invoice_item_id
  ) alloc ON alloc.receiving_invoice_item_id = rii.id
  WHERE ${where}
  GROUP BY ro.id, ro.ref_no, ro.status, ro.delivery_date, s.name
  ORDER BY ro.delivery_date;`;
```

- [ ] **Step 3: Render the badge in the template**

In the right-hand column of the card (around the existing remaining-qty badge), add:

```vue
          <span
            v-if="ro.pending_picking_orders > 0"
            class="badge"
            style="margin-top: 0.25rem; background: #dbeafe; color: #1e40af;"
          >
            {{ ro.pending_picking_orders }} picking{{ ro.pending_picking_orders === 1 ? '' : 's' }}
          </span>
```

Place it after the remaining-qty badge so the card reads: status → date → remaining → picking.

- [ ] **Step 4: Type-check and commit**

Run:

```bash
pnpm nuxt prepare
```

Expected: no TypeScript errors.

Then commit:

```bash
git add pages/receiving/index.vue
git commit -m "feat(receiving): show pending picking order count in list"
```

---

### Task 2: Manual verification

**Files:**
- Test in browser only; no automated tests.

- [ ] **Step 1: Start the dev server**

From the feature worktree root:

```bash
pnpm dev
```

Open `http://localhost:3001` and log in as `operator` / `DocPal2026!`.

- [ ] **Step 2: Navigate to the receiving list**

Go to `/receiving` and ensure the filter is set to **In hand**.

- [ ] **Step 3: Verify expected counts**

Based on the seeded data and allocation logic, the following badges should appear:

| Receiving Order | Expected picking badge |
|-----------------|------------------------|
| `RO-240701-001` | `3 pickings` (TN-240701-002, TN-240701-003, TN-240701-004) |
| `RO-240701-002` | `1 picking` (TN-240701-005) |
| `RO-240615-001` | no badge |
| Pending orders  | no badge |

- [ ] **Step 4: Verify reactivity**

Open `RO-240701-002`, go to the **Picking** tab, and use the scan button to pick the remaining quantity for the linked picking order (`TN-240701-005`).

Return to the receiving list. The picking badge for `RO-240701-002` should disappear (or drop to `0`, hence hidden).

- [ ] **Step 5: Commit verification notes (optional)**

If everything looks correct, no further commit is required. If any adjustment is needed, commit the fix separately.

---

## Self-Review Checklist

- **Spec coverage:**
  - Count distinct picking orders — implemented via `COUNT(DISTINCT pi.picking_order_id)`.
  - Only un-picked allocations — implemented via `a.qty > pi.picked_qty`.
  - Badge hidden when zero — implemented via `v-if="ro.pending_picking_orders > 0"`.
  - Reactive — uses existing `useLiveQuery`.

- **Placeholder scan:**
  - No TBD/TODO placeholders.
  - Exact file path and code blocks included.

- **Type consistency:**
  - `pending_picking_orders: number` matches the SQL alias.
  - Template uses `ro.pending_picking_orders` consistently.
