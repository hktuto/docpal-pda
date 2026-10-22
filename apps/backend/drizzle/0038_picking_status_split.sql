-- Picking status split (spec docs/superpowers/specs/2026-10-22-picking-status-split-design.md):
-- the operator Finish lands on 'picking_finished'; measuring completion flips to 'measuring_finished'.
UPDATE "picking_orders" SET "status" = 'picking_finished' WHERE "status" = 'finished';
