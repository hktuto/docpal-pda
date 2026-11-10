# Internal Transfer Overview

Internal transfer orders are upstream-synced stock moves **within** this
warehouse — from one `(org, sub_inventory)` partition to another. They never
ship. (Distinct from *transfer picking* — normal picking orders shipping
another warehouse's stock.)

## When to use it

Admin console, **Internal Transfers** (nav gated by the `internal-transfer`
flow step). Use it when a synced transfer order arrives and an admin must
decide how it gets its stock and where the stock goes.

## Concept

An internal transfer is both a **demand** and a **supply**:

- **Demand:** like a picking order — the admin presses per-order
  **Re-allocate** and the engine reserves shelved stock / in-hand receiving
  stock restricted to the order's `from_` partition (shelf lots FIFO, then
  dock FIFO; manual pins survive). Manual add/remove per item via the 🔍
  availability dialog.
- **Supply:** the admin may link a **delegated picking order** (org must match
  the transfer's `to_` org). When the transfer finishes (PDA stage, not built
  yet), its picked stock lands at the `to_` partition and feeds that picking
  order's allocation. Unlinked → finish creates a put-away task instead.

Stage 1 (shipped) covers the admin side only: list, detail, Re-allocate,
assignment, manual allocation add/remove. PDA transfer picking and the finish
branches are stage 2.

See `docs/superpowers/specs/2026-11-10-internal-transfer-admin-allocate-design.md`.
