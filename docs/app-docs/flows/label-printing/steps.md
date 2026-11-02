# Label Printing — Operator Steps

## 1. Open Label Printing

From the home screen, tap **Label Printing / 打印標籤**. The list shows
picking orders that were finished and still need their labels printed, newest
update first. Use the search box to filter by order no / customer / ship-to;
tap **Load more** for older orders.

Each row shows the order number, customer/ship-to, and a chip with how many
labels the order's rules currently match.

## 2. Open the order

Tap a row to open the label-printing detail (`/label-printing/:id`). The
header shows the order number, customer, ship-to, and status.

## 3. Print the labels

The page lists the order's matched label rules (one row per rule: rule name,
label type, template):

- **Print** per row — prints that label with the template's default printer;
  a spinner tracks the print job and errors show as toasts.
- **Print all** — prints every matched label in one go.
- Labels are re-printable as many times as needed — every print (reprints
  included) is recorded server-side and later checked in Verify.
- A rule marked **external** shows an info row ("label provided by customer")
  with no Print button — the customer supplies those labels.

If the rules were edited since the order finished and no longer match, an
info line says so in place of the print rows — the finish action stays
available.

## 4. Finish printing

Tap **Finish printing** and confirm. The order leaves the printing queue and
moves on to the **Labeling** queue (the app opens its labeling page) — or,
when the labeling step is turned off, its boxes become eligible for Measuring
(or get their verify tasks when the measuring step is off) and you return to
the label-printing list.

If another operator already finished the order, the app treats the
"not pending" response as already-done and returns to the list.

## Notes

- Any operator may finish printing — it is a shared printer-bench task, not
  tied to the picker who finished the order.
- The immediate print prompt at picking finish still appears; this queue is
  the print-later / bench-printing path.
