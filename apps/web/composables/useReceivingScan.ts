import { ref } from "vue";
import { ApiError } from "~/services/apiClient";
import {
  captureLabel,
  captureRawLabelValue,
  useLabelScan,
} from "~/composables/useLabelScan";
import { useErrorMessage } from "~/composables/errorMessage";
import { useWarehouse } from "~/composables/useWarehouse";
import { extractMultiItemRows } from "~/utils/parseOcrScan";
import type {
  ReceivingScanCandidate,
  ReceivingScanInput,
} from "~/services/types";

export interface ReceivingScanReview {
  message: "no_match" | "multiple_matches";
  candidates: ReceivingScanCandidate[];
  /** Best-effort qty parsed client-side from the raw label (may be null). */
  initialQty: number | null;
}

/** One editable item row in the multi-item scan review table. */
export interface MultiScanRow {
  partNo: string;
  qty: number | null;
}

export interface MultiApplyResult {
  partNo: string;
  ok: boolean;
  message?: string;
}

export type ReceivingScanOutcome =
  | { status: "applied" }
  | { status: "review" }
  | { status: "cancelled" }
  | { status: "error"; message: string };

export interface UseReceivingScanOptions {
  onApplied?: () => void | Promise<void>;
  /**
   * The order's invoice items, used to detect a multi-item label client-side
   * before posting to the server (a raw OCR text scan with no QR-template
   * match would otherwise fail with a plain 400 qty error).
   */
  scanItems?: () => ReceivingScanCandidate[];
}

/**
 * Receiving-order scan flow against POST /receiving-orders/:id/scan: the
 * server parses/matches the raw label. A 409 {message, candidates} opens the
 * review modal; picking a candidate resends the scan with explicit
 * {partNo, qty} (the raw is kept so server-side serial dedup still works).
 * A raw label that parses into 2+ item rows opens the multi-item table UI
 * instead (applied row-by-row via applyRows).
 */
export function useReceivingScan(options: UseReceivingScanOptions = {}) {
  const warehouse = useWarehouse();
  const errorMessage = useErrorMessage();
  const { parseRawValue } = useLabelScan();
  const { t, te } = useI18n();

  /** Translate a server snake_code message when an errors.* key exists. */
  function serverErrorMessage(err: unknown): string {
    if (err instanceof ApiError && te(`errors.${err.message}`)) {
      return t(`errors.${err.message}`);
    }
    return errorMessage(err);
  }

  const scanning = ref(false);
  const applying = ref(false);
  const review = ref<ReceivingScanReview | null>(null);
  const reviewOpen = ref(false);
  /** Multi-item label review (table UI): rows parsed from one raw capture. */
  const multiReview = ref<{
    rows: MultiScanRow[];
    candidates: ReceivingScanCandidate[];
  } | null>(null);
  const multiOpen = ref(false);

  let lastOrderId = "";
  let lastRaw: string | undefined;
  let lastSupplierCode: string | undefined;

  function isMatchConflict(
    e: unknown
  ): e is ApiError & { body: { message: "no_match" | "multiple_matches"; candidates: unknown[] } } {
    if (!(e instanceof ApiError) || e.status !== 409 || !e.body) return false;
    const message = e.body.message;
    return (
      (message === "no_match" || message === "multiple_matches") &&
      Array.isArray(e.body.candidates)
    );
  }

  async function submit(
    orderId: string,
    input: ReceivingScanInput,
    supplierCode?: string
  ): Promise<ReceivingScanOutcome> {
    // Multi-item label pre-check: a raw capture whose lines match 2+ of the
    // order's items opens the table UI without a server round-trip.
    if (input.raw && !input.partNo) {
      const items = options.scanItems?.() ?? [];
      if (items.length >= 2) {
        const rows = extractMultiItemRows(
          input.raw,
          items.map((i) => i.partNo)
        );
        if (rows.length >= 2) {
          lastOrderId = orderId;
          multiReview.value = {
            rows: rows.map((r) => ({ partNo: r.partNo, qty: r.qty ?? null })),
            candidates: items,
          };
          multiOpen.value = true;
          return { status: "review" };
        }
      }
    }
    try {
      await warehouse.scanReceiving(orderId, input);
      await options.onApplied?.();
      return { status: "applied" };
    } catch (e) {
      if (isMatchConflict(e)) {
        const candidates = e.body.candidates as ReceivingScanCandidate[];
        // A label whose items table lists several parts parses into 2+ rows:
        // open the multi-item table UI instead of the single-candidate modal.
        if (input.raw) {
          const rows = extractMultiItemRows(
            input.raw,
            candidates.map((c) => c.partNo)
          );
          if (rows.length >= 2) {
            lastOrderId = orderId;
            multiReview.value = {
              rows: rows.map((r) => ({ partNo: r.partNo, qty: r.qty ?? null })),
              candidates,
            };
            multiOpen.value = true;
            return { status: "review" };
          }
        }
        let initialQty = input.qty ?? null;
        if (initialQty === null && input.raw) {
          try {
            const parsed = await parseRawValue(input.raw, supplierCode);
            initialQty =
              typeof parsed.parsed.qty === "number" ? parsed.parsed.qty : null;
          } catch {
            // best-effort prefill only — the modal lets the user type the qty
          }
        }
        lastOrderId = orderId;
        if (input.raw) lastRaw = input.raw;
        lastSupplierCode = supplierCode;
        review.value = {
          message: e.body.message,
          candidates,
          initialQty,
        };
        reviewOpen.value = true;
        return { status: "review" };
      }
      return { status: "error", message: errorMessage(e) };
    }
  }

  /** Camera / manual-prompt capture, then submit the raw label. */
  async function scan(
    orderId: string,
    supplierCode?: string
  ): Promise<ReceivingScanOutcome> {
    scanning.value = true;
    try {
      const capture = await captureLabel();
      if (!capture) return { status: "cancelled" };
      return await submit(orderId, { raw: captureRawLabelValue(capture) }, supplierCode);
    } catch (e) {
      return { status: "error", message: errorMessage(e) };
    } finally {
      scanning.value = false;
    }
  }

  /** Hardware / wedge scan entry point: submit an already-captured raw value. */
  async function submitRaw(
    orderId: string,
    raw: string,
    supplierCode?: string
  ): Promise<ReceivingScanOutcome> {
    scanning.value = true;
    try {
      return await submit(orderId, { raw }, supplierCode);
    } finally {
      scanning.value = false;
    }
  }

  /** Review-modal pick: resend with the candidate's part number + chosen qty. */
  async function pickCandidate(
    candidate: ReceivingScanCandidate,
    qty: number
  ): Promise<ReceivingScanOutcome> {
    applying.value = true;
    try {
      const result = await submit(
        lastOrderId,
        { raw: lastRaw, partNo: candidate.partNo, qty },
        lastSupplierCode
      );
      if (result.status === "applied") {
        reviewOpen.value = false;
        review.value = null;
      }
      return result;
    } finally {
      applying.value = false;
    }
  }

  /**
   * Multi-item apply: send one explicit {partNo, qty} scan per row,
   * sequentially so the per-row guards (qty cap, duplicate part) report
   * cleanly. `raw` is intentionally not resent — a label serial would trip
   * the dedup check on the second row. Rows that already succeeded should be
   * filtered out by the caller before retrying.
   */
  async function applyRows(rows: MultiScanRow[]): Promise<MultiApplyResult[]> {
    applying.value = true;
    const results: MultiApplyResult[] = [];
    try {
      for (const row of rows) {
        try {
          await warehouse.scanReceiving(lastOrderId, {
            partNo: row.partNo,
            qty: row.qty ?? undefined,
          });
          results.push({ partNo: row.partNo, ok: true });
        } catch (err) {
          results.push({ partNo: row.partNo, ok: false, message: serverErrorMessage(err) });
        }
      }
      if (results.some((r) => r.ok)) {
        await options.onApplied?.();
      }
      return results;
    } finally {
      applying.value = false;
    }
  }

  function closeMulti() {
    multiOpen.value = false;
    multiReview.value = null;
  }

  return {
    scanning,
    applying,
    review,
    reviewOpen,
    multiReview,
    multiOpen,
    scan,
    submitRaw,
    pickCandidate,
    applyRows,
    closeMulti,
  };
}
