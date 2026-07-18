import { ref } from "vue";
import { ApiError } from "~/services/apiClient";
import {
  captureLabel,
  captureRawLabelValue,
  useLabelScan,
} from "~/composables/useLabelScan";
import { useErrorMessage } from "~/composables/errorMessage";
import { useWarehouse } from "~/composables/useWarehouse";
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

export type ReceivingScanOutcome =
  | { status: "applied" }
  | { status: "review" }
  | { status: "cancelled" }
  | { status: "error"; message: string };

export interface UseReceivingScanOptions {
  onApplied?: () => void | Promise<void>;
}

/**
 * Receiving-order scan flow against POST /receiving-orders/:id/scan: the
 * server parses/matches the raw label. A 409 {message, candidates} opens the
 * review modal; picking a candidate resends the scan with explicit
 * {partNo, qty} (the raw is kept so server-side serial dedup still works).
 */
export function useReceivingScan(options: UseReceivingScanOptions = {}) {
  const warehouse = useWarehouse();
  const errorMessage = useErrorMessage();
  const { parseRawValue } = useLabelScan();

  const scanning = ref(false);
  const applying = ref(false);
  const review = ref<ReceivingScanReview | null>(null);
  const reviewOpen = ref(false);

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
    try {
      await warehouse.scanReceiving(orderId, input);
      await options.onApplied?.();
      return { status: "applied" };
    } catch (e) {
      if (isMatchConflict(e)) {
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
          candidates: e.body.candidates as ReceivingScanCandidate[],
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

  return {
    scanning,
    applying,
    review,
    reviewOpen,
    scan,
    submitRaw,
    pickCandidate,
  };
}
