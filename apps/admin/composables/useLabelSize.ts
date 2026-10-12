// Shared label-size selection for the print dialogs. The picked size is
// persisted in localStorage (`label_size`) so every print dialog opens with
// the last size used; the render helpers in utils/print.ts draw the label at
// that size (single labels and the A4 batch grid).
import { loadLabelSize, saveLabelSize, type LabelSizeId } from "~/utils/print";

export function useLabelSize() {
  const size = ref<LabelSizeId>("medium");
  onMounted(() => {
    size.value = loadLabelSize();
  });
  watch(size, (v) => saveLabelSize(v));
  return size;
}
