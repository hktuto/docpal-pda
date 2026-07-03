import { useLabelScan, createManualReview, type LabelScanResult } from "~/composables/useLabelScan";

export interface UseLabelScanReviewOptions {
  onApplied?: () => void | Promise<void>;
}

export function useLabelScanReview(options: UseLabelScanReviewOptions = {}) {
  const { scan: rawScan, scanning } = useLabelScan();
  const reviewOpen = ref(false);
  const review = ref<LabelScanResult | null>(null);

  async function handleResult(result: LabelScanResult) {
    if (result.status === "applied") {
      await options.onApplied?.();
    } else if (result.status === "review") {
      review.value = result;
      reviewOpen.value = true;
    } else if (result.status === "manual") {
      review.value = createManualReview();
      reviewOpen.value = true;
    }
  }

  async function scan(context: Parameters<typeof rawScan>[0]) {
    const result = await rawScan(context);
    if (result.status !== "cancelled" && result.status !== "error") {
      await handleResult(result);
    }
    return result;
  }

  async function onApplied() {
    reviewOpen.value = false;
    await options.onApplied?.();
  }

  return {
    scan,
    scanning,
    review,
    reviewOpen,
    onApplied,
  };
}
