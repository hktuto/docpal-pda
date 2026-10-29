import { index, pgTable, text, integer, timestamp, jsonb } from "drizzle-orm/pg-core";
import { now } from "../now.js";
import { pickingOrders } from "./picking.js";
import { labelPrintRules } from "./label-print.js";

// One row per label print ACTION (a reprint is a new row — full history).
// payload: array of per-label rows {shippingBoxId, packageId, params} where
// params is the exact printingParams row sent to the print service; carton
// rows carry shippingBoxId, item/item_box rows carry packageId.
// rule_id/label_type/print_template_id are denormalized so history survives
// rule edits; no cascade delete.
export const labelPrints = pgTable(
  "label_prints",
  {
    id: text("id").primaryKey(),
    pickingOrderId: text("picking_order_id").notNull().references(() => pickingOrders.id),
    ruleId: text("rule_id").notNull().references(() => labelPrintRules.id),
    labelType: text("label_type").notNull(), // carton | item_box | item
    printTemplateId: text("print_template_id").notNull(),
    printerName: text("printer_name"),
    serviceId: text("service_id"),
    deviceKey: text("device_key"),
    expectedLabelCount: integer("expected_label_count").notNull(),
    payload: jsonb("payload").notNull(),
    result: jsonb("result"),
    printedBy: text("printed_by").notNull(),
    createdDate: timestamp("created_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
    lastUpdateDate: timestamp("last_update_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
  },
  (t) => ({
    orderIdx: index("idx_label_prints_order").on(t.pickingOrderId),
  })
);
