import * as schema from "~/db/schema";

export type DisplayReceivingItem = typeof schema.receivingInvoiceItems.$inferSelect & {
  part?: typeof schema.parts.$inferSelect | null;
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

export interface DisplayPackage {
  id: string;
  pickingItemId: string;
  pickingOrderId: string;
  qty: number;
  shippingBoxId: string | null;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  createdAt: Date | string;
}

export interface DisplayBox {
  id: string;
  pickingOrderId: string;
  status: string;
}

export interface TransitionLog {
  id: string;
  entityId: string;
  fromState: string | null;
  toState: string;
  metadata: string | null;
  createdAt: Date | string;
  actorName?: string | null;
}

export interface GroupedItem {
  id: string;
  part_id: string;
  part_no: string;
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
