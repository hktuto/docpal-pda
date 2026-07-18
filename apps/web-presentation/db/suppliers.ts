import { isNotNull } from "drizzle-orm";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "./schema";
import type { SupplierQrcodeTemplate } from "~/services/types";

export async function getSuppliersWithQrTemplates(
  db: PgliteDatabase<typeof schema>
): Promise<SupplierQrcodeTemplate[]> {
  const rows = await db
    .select({
      code: schema.suppliers.code,
      qrcodeTemplate: schema.suppliers.qrcodeTemplate,
      qrcodeQtyEncoding: schema.suppliers.qrcodeQtyEncoding,
    })
    .from(schema.suppliers)
    .where(isNotNull(schema.suppliers.qrcodeTemplate));

  return rows.map((r) => ({
    code: r.code,
    qrcodeTemplate: r.qrcodeTemplate,
    qrcodeQtyEncoding: r.qrcodeQtyEncoding ?? null,
  }));
}
