# Labeling — Operator Steps

## 1. Open Labeling

From the home screen, tap **Labeling / 待貼標籤**. The list shows picking
orders that were finished and still need their labels stuck, newest update
first — orders arrive here after [Label Printing](../label-printing/steps.md)
is finished (or straight from picking finish when the printing step does not
apply). Use the search box to filter by order no / customer / ship-to; tap
**Load more** for older orders.

Each row shows the order number, customer/ship-to, and a chip with how many
labels the order's rules currently match.

## 2. Open the order

Tap a row to open the labeling detail (`/labeling/:id`). The header shows the
order number, customer, ship-to, and status.

## 3. Check / re-print the labels

The labels should already be printed in the **Label Printing** stage. This
page lists the order's matched label rules (one row per rule: rule name,
label type, template) for reprints and external-label info:

- **Print** per row — prints that label with the template's default printer;
  a spinner tracks the print job and errors show as toasts.
- **Print all** in the panel header prints every internal rule in one go
  (external info rows are skipped).
- Labels are re-printable as many times as needed — every print (reprints
  included) is recorded server-side and later checked in Verify.
- A rule marked **external** shows an info row ("label provided by customer")
  with no Print button — the customer supplies those labels; just stick them
  when they arrive.

If the rules were edited since the order finished and no longer match, an
info line says so in place of the print rows — the finish action stays
available.

## 4. Finish labeling

Tap **Finish labeling** and confirm. The order leaves the queue and its boxes
become eligible for Measuring (or get their verify tasks when the measuring
step is off). You return to the labeling list.

If another operator already finished the order, the app treats the
"not pending" response as already-done and returns to the list.

## Notes

- Any operator may finish labeling — it is a shared packing-bench task, not
  tied to the picker who finished the order.
- The immediate print prompt at picking finish still appears; routine printing
  belongs to the Label Printing queue — this queue is the
  verify-the-labels-are-stuck path.
