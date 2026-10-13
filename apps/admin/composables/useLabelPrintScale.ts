// Shared A4 batch print scale factor (percent) for the print dialogs. Printers
// auto-fit the sheet into their printable area and shrink it slightly; a scale
// above 100 renders the batch grid larger so the printed label lands at its
// true physical size. Persisted in localStorage (`label_print_scale`) so every
// batch dialog opens with the last value used; single labels are unaffected.
import { loadLabelPrintScale, saveLabelPrintScale } from "~/utils/print";

export function useLabelPrintScale() {
  const scale = ref(100);
  onMounted(() => {
    scale.value = loadLabelPrintScale();
  });
  watch(scale, (v) => saveLabelPrintScale(v));
  return scale;
}
