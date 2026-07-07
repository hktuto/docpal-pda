import * as schema from "~/db/schema";
import type {
  PickingByReceivingRow,
  PickingPackage,
  ShippingBox,
  TransitionLog,
} from "~/services/types";

export type DisplayReceivingItem = typeof schema.receivingInvoiceItems.$inferSelect & {
  part?: typeof schema.parts.$inferSelect | null;
  mismatch?: typeof schema.receivingItemMismatches.$inferSelect & {
    reportedByUser?: typeof schema.users.$inferSelect | null;
    confirmedByUser?: typeof schema.users.$inferSelect | null;
  } | null;
};

export interface DisplayReceivingOrder {
  id: string;
  refNo: string;
  status: string;
  supplier?: typeof schema.suppliers.$inferSelect | null;
  deliveryDate: Date | null;
  invoices: Array<
    Omit<typeof schema.receivingInvoices.$inferSelect, "receivingOrderId"> & {
      items: DisplayReceivingItem[];
    }
  >;
}

export type DisplayPackage = PickingPackage;

export type DisplayBox = ShippingBox;

export type { TransitionLog, PickingByReceivingRow };

export interface GroupedItem {
  id: string;
  part_id: string;
  part_no: string | null;
  required_qty: number;
  picked_qty: number;
  scanned_qty: number;
  boxed_qty: number;
  locations: Array<{
    shelf_code: string | null;
    box_id: string | null;
    date_code: string | null;
    lot_code: string | null;
    coo: string | null;
    cow: string | null;
    allocated_qty: number;
  }>;
}

export interface GroupedOrder {
  id: string;
  ref_no: string;
  status: string;
  items: GroupedItem[];
}
