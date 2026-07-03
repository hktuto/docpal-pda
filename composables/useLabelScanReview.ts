import { useLabelScan, createManualReview, type LabelScanResult } from "~/composables/useLabelScan";

export interface UseLabelScanReviewOptions {
  onApplied?: () => void | Promise<void>;
}

export function useLabelScanReview(options: UseLabelScanReviewOptions = {}) {
  const { scan, scanning, error } = useLabelScan();
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
    } else if (result.status === "error") {
      error.value = result.message;
    }
  }

  async function onApplied() {
    reviewOpen.value = false;
    await options.onApplied?.();
  }

  return {
    scan,
    scanning,
    error,
    review,
    reviewOpen,
    handleResult,
    onApplied,
  };
}
