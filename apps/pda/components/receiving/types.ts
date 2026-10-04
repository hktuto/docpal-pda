import type { ReceivingItem, ReceivingOrderDetail } from "~/services/types";

// The backend detail DTO already embeds each item's part, allocatedQty and
// active mismatch, so the display types are the DTOs themselves.
export type DisplayReceivingItem = ReceivingItem;

export type DisplayReceivingOrder = ReceivingOrderDetail;
