import { eq } from "drizzle-orm";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { useDb } from "./useDb";
import { useMockOcr } from "./useMockOcr";
import type { OcrInput } from "./useMockOcr";
import { useCurrentUser } from "./useCurrentUser";
import {
  findReceivingCandidates,
  findPickingCandidates,
  applyOcrPick,
} from "~/db/ocrPicking";
import {
  materializeReceivingAllocation,
  scanAllocationToPackage,
} from "~/db/picking";
import { addItemToShelfBox, getPutAwayLots } from "~/db/putAway";
import {
  findMatchingUnverifiedPackage,
  verifyPickingPackageForMeasuring,
} from "~/db/measuring";
import { verifyShelfBoxItem, getShelfBoxDetail } from "~/db/goodsVerify";
import * as schema from "~/db/schema";

export type ScanMatchResult =
  | { type: "single"; record: unknown; apply: () => Promise<void> }
  | { type: "multiple"; records: unknown[] }
  | { type: "none" }
  | { type: "error"; message: string };

export type ScanTask =
  | "receiving"
  | "picking"
  | "put-away"
  | "measuring"
  | "goods-verify";

export interface ScanTaskContext {
  task: ScanTask;
  receivingOrderId?: string;
  allocationId?: string;
  boxId?: string;
  shelfBoxId?: string;
  targetBoxId?: string; // for put-away
  pickingItemId?: string; // for receiving
  targetPackageId?: string; // for measuring
}

export interface ScanMatchers {
  matchReceiving(
    receivingOrderId: string,
    pickingItemId: string | undefined,
    parsed: OcrInput
  ): Promise<ScanMatchResult>;
  matchPicking(allocationId: string, parsed: OcrInput): Promise<ScanMatchResult>;
  matchPutAway(
    receivingOrderId: string,
    targetBoxId: string,
    parsed: OcrInput
  ): Promise<ScanMatchResult>;
  matchMeasuring(
    boxId: string,
    targetPackageId: string | undefined,
    parsed: OcrInput
  ): Promise<ScanMatchResult>;
  matchGoodsVerify(
    shelfBoxId: string,
    parsed: OcrInput
  ): Promise<ScanMatchResult>;
}

export function useScanMatchers(): ScanMatchers {
  const db = useDb();
  const { parseManual } = useMockOcr();

  async function getActorId(): Promise<string | null> {
    const user = await useCurrentUser();
    return user?.id ?? null;
  }

  async function matchReceiving(
    receivingOrderId: string,
    pickingItemId: string | undefined,
    parsed: OcrInput
  ): Promise<ScanMatchResult> {
    try {
      const actorId = await getActorId();
      if (!actorId) return { type: "error", message: "No authenticated user" };

      const p = parseManual(parsed);
      const receiving = await findReceivingCandidates(db, receivingOrderId, p);
      if (receiving.length === 0) return { type: "none" };

      const item = receiving[0];
      if (p.qty > item.availableQty) return { type: "none" };

      let picking = await findPickingCandidates(
        db,
        receivingOrderId,
        item.partId,
        p.qty
      );
      if (picking.length === 0) return { type: "none" };

      if (pickingItemId) {
        picking = picking.filter((c) => c.pickingItemId === pickingItemId);
      }

      if (picking.length === 0) return { type: "none" };

      if (picking.length === 1) {
        return {
          type: "single",
          record: { receiving: item, picking: picking[0] },
          apply: () =>
            applyOcrPick(
              db,
              item.receivingInvoiceItemId,
              picking[0].pickingItemId,
              p.qty,
              item.dateCode,
              item.lotCode,
              item.coo,
              item.cow,
              actorId
            ),
        };
      }

      return {
        type: "multiple",
        records: picking.map((candidate) => ({
          receiving: item,
          picking: candidate,
        })),
      };
    } catch (e: any) {
      return {
        type: "error",
        message: e?.message ?? "Receiving match failed",
      };
    }
  }

  async function matchPicking(
    allocationId: string,
    parsed: OcrInput
  ): Promise<ScanMatchResult> {
    try {
      const actorId = await getActorId();
      if (!actorId) return { type: "error", message: "No authenticated user" };

      const p = parseManual(parsed);

      const allocation = await db.query.allocations.findFirst({
        where: eq(schema.allocations.id, allocationId),
      });

      if (!allocation) return { type: "none" };
      if (p.qty <= 0 || p.qty > allocation.qty) {
        return { type: "error", message: "Qty exceeds allocated quantity" };
      }

      if (allocation.receivingInvoiceItemId) {
        return {
          type: "single",
          record: { allocation },
          apply: async () => {
            const materializedId = await materializeReceivingAllocation(
              db,
              allocation.id,
              p.qty,
              p.dateCode,
              p.lotCode,
              p.coo,
              p.cow
            );
            await scanAllocationToPackage(db, materializedId, p.qty, actorId);
          },
        };
      }

      if (allocation.inventoryLotId) {
        return {
          type: "single",
          record: { allocation },
          apply: () => scanAllocationToPackage(db, allocation.id, p.qty, actorId),
        };
      }

      return { type: "error", message: "Allocation has no source" };
    } catch (e: any) {
      return {
        type: "error",
        message: e?.message ?? "Picking match failed",
      };
    }
  }

  async function matchPutAway(
    receivingOrderId: string,
    targetBoxId: string,
    parsed: OcrInput
  ): Promise<ScanMatchResult> {
    try {
      const actorId = await getActorId();
      if (!actorId) return { type: "error", message: "No authenticated user" };

      if (!targetBoxId) {
        return { type: "error", message: "Missing target box" };
      }

      const p = parseManual(parsed);

      const lots = await getPutAwayLots(db, receivingOrderId);
      const matches = lots.filter((lot) => {
        if ((lot.part_no ?? "").trim().toUpperCase() !== p.partNo) return false;
        if (p.qty > lot.available_qty) return false;
        if (
          p.dateCode &&
          (lot.date_code ?? "").trim().toUpperCase() !== p.dateCode
        ) {
          return false;
        }
        if (
          p.lotCode &&
          (lot.lot_code ?? "").trim().toUpperCase() !== p.lotCode
        ) {
          return false;
        }
        if (p.coo && (lot.coo ?? "").trim().toUpperCase() !== p.coo)
          return false;
        if (p.cow && (lot.cow ?? "").trim().toUpperCase() !== p.cow)
          return false;
        return true;
      });

      if (matches.length === 0) return { type: "none" };
      if (matches.length > 1) return { type: "multiple", records: matches };

      const lot = matches[0];

      return {
        type: "single",
        record: { lot },
        apply: () =>
          addItemToShelfBox(
            db,
            targetBoxId,
            lot.receiving_invoice_item_id,
            p.qty,
            p.dateCode,
            p.lotCode,
            p.coo,
            p.cow,
            actorId
          ),
      };
    } catch (e: any) {
      return {
        type: "error",
        message: e?.message ?? "Put-away match failed",
      };
    }
  }

  async function matchMeasuring(
    boxId: string,
    targetPackageId: string | undefined,
    parsed: OcrInput
  ): Promise<ScanMatchResult> {
    try {
      const currentUser = await useCurrentUser();
      if (!currentUser?.id) {
        return { type: "error", message: "No authenticated user" };
      }

      const p = parseManual(parsed);
      const input = {
        partNo: p.partNo,
        dateCode: p.dateCode ?? "",
        lotCode: p.lotCode ?? "",
        coo: p.coo ?? "",
        cow: p.cow ?? "",
        qty: p.qty,
      };

      const matched = await findMatchingUnverifiedPackage(
        db,
        boxId,
        input,
        targetPackageId
      );
      if (!matched) return { type: "none" };

      return {
        type: "single",
        record: { package: matched },
        apply: () =>
          verifyPickingPackageForMeasuring(db, matched.id, currentUser.id),
      };
    } catch (e: any) {
      return {
        type: "error",
        message: e?.message ?? "Measuring match failed",
      };
    }
  }

  async function matchGoodsVerify(
    shelfBoxId: string,
    parsed: OcrInput
  ): Promise<ScanMatchResult> {
    try {
      const p = parseManual(parsed);

      const box = await getShelfBoxDetail(db, shelfBoxId);
      if (!box) return { type: "error", message: "Shelf box not found" };

      const item = box.items.find(
        (i) => !i.verified && (i.part?.partNo || "") === p.partNo
      );

      if (!item) return { type: "none" };

      return {
        type: "single",
        record: { item },
        apply: () => verifyShelfBoxItem(db, item.id),
      };
    } catch (e: any) {
      return {
        type: "error",
        message: e?.message ?? "Goods verify match failed",
      };
    }
  }

  return {
    matchReceiving,
    matchPicking,
    matchPutAway,
    matchMeasuring,
    matchGoodsVerify,
  };
}
