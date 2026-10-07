import { computed, readonly, ref } from "vue";
import type { OutdatedScanWarning } from "~/services/types";
import { setOutdatedWarningHandler } from "~/services/scanWarningBus";

/**
 * Global queue of supplier outdated date-code warnings (spec
 * docs/superpowers/specs/2026-10-07-supplier-outdated-datecode-warning-design.md).
 * The backend scan endpoints (picking item scan, shipping-box scan, put-away
 * scan) stay 2xx when a label's date code is too old and carry the warning on
 * the response; the warehouse adapter reports it through the scan-warning bus
 * (registered here at module load — this module is imported by the
 * always-mounted OutdatedWarningDialog) and the dialog shows one dismissible
 * alert per warning — including the OCR path, which posts through the same
 * endpoints inside the scan matchers.
 */
const queue = ref<OutdatedScanWarning[]>([]);

export function reportOutdatedWarning(warning: OutdatedScanWarning | null | undefined): void {
  if (warning) queue.value = [...queue.value, warning];
}

setOutdatedWarningHandler((warning) => reportOutdatedWarning(warning));

/** Dismiss the currently shown warning, revealing the next queued one. */
export function dismissOutdatedWarning(): void {
  queue.value = queue.value.slice(1);
}

export function useOutdatedWarningState() {
  return {
    warnings: readonly(queue),
    current: computed(() => queue.value[0] ?? null),
  };
}
