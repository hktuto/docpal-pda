// Shared label-size selection for the print dialogs. The picked size is
// persisted in localStorage (`label_size`) so every print dialog opens with
// the last size used; the render helpers in utils/print.ts draw the label at
// that size (single labels and the A4 batch grid). The choice is validated
// against the active per-warehouse catalog — a pick from the other
// warehouse's list falls back to that catalog's default when it lands.
import {
  activeLabelSizes,
  defaultLabelSizeId,
  loadLabelSize,
  saveLabelSize,
  type LabelSizeId,
} from "~/utils/print";

export function useLabelSize() {
  const size = ref<LabelSizeId>(defaultLabelSizeId());
  onMounted(() => {
    size.value = loadLabelSize();
  });
  watch(size, (v) => saveLabelSize(v));
  // The warehouse catalog resolves with the /config fetch — re-resolve the
  // saved pick when it arrives (it may not exist in the other catalog).
  watch(activeLabelSizes, () => {
    size.value = loadLabelSize();
  });
  return size;
}
