// Warehouse identity for Excel export renderer scoping. One backend instance
// serves exactly one warehouse; WAREHOUSE_CODE names it (same env the seed
// uses, default "hk"). Exported here so routes can pass the warehouse into
// resolveRenderer — a renderer registered with { warehouse: "sz" } then wins
// over the unscoped default on the SZ instance, while every other warehouse
// keeps the default (HK) layout.

export function exportWarehouseCode(): string {
  return (process.env.WAREHOUSE_CODE ?? "hk").toLowerCase();
}
