/** Instance-level default warehouse code (env WAREHOUSE_CODE, default "HK1").
 *  Each deployed backend instance serves one warehouse; rows created through
 *  the ORM inherit this as their warehouse_code default. */
export function defaultWarehouse(): string {
  return process.env.WAREHOUSE_CODE ?? "HK1";
}
