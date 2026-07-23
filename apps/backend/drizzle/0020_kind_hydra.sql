-- Default picking priority is now (delivery_date ASC NULLS LAST, order_no)
-- instead of creation order. Re-sequence open orders to the new default
-- (supersedes any manual reorders made before this rule existed).
UPDATE "picking_orders" SET priority_seq = r.seq
FROM (
  SELECT id, row_number() OVER (ORDER BY delivery_date ASC NULLS LAST, order_no) AS seq
  FROM "picking_orders"
  WHERE status IN ('pending', 'picking')
) r
WHERE "picking_orders".id = r.id;