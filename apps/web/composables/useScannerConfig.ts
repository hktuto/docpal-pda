import { registerPlugin } from "@capacitor/core";
import { getCachedSupplierQrTemplates } from "~/composables/useLabelScan";
import { useWarehouse } from "~/composables/useWarehouse";

/**
 * Scanner-symbology control for xcheng/Movfast PDAs. The native
 * ScannerConfigPlugin talks to the system scanner app over its exported
 * broadcast API (ENABLE/DISABLE_SCANTYPE_BROADCAST); the setting is
 * runtime-only and device-global, so screens re-apply on enter and restore on
 * leave, and app startup restores the full set (crash recovery). On other
 * devices the native side is a harmless no-op, and in the browser the web
 * stub below no-ops.
 */

/**
 * Every symbology the xcheng scanner app supports, using its settings-app
 * display names (validated server-side against its string resources — the
 * exact spelling matters, e.g. "QR CODE" with a space). Keep in sync with
 * ScannerConfigPlugin.ALL_SYMBOLOGIES and the admin copy in
 * apps/admin/utils/symbologies.ts.
 */
export const SCANNER_SYMBOLOGIES: readonly string[] = [
  "AZTEC", "BC412", "Code11", "Code39", "Code49", "Code93", "Code128",
  "Codabar", "CODABLOCK F", "DOTCODE", "DATA MATRIX", "EAN-8", "EAN-13",
  "GS1 DATABAR", "GS1-128", "GS1 DATA MATRIX", "HANXIN", "HK25", "ITF25",
  "Korea POST", "MATRIX 25", "MAXICODE", "MSI", "MICROPDF", "NEC25",
  "PDF417", "USPS4ST", "QR CODE", "INDUSTRIAL 25", "TELEPEN", "UPC-A",
  "UPC-E", "IATA25", "Grid Matrix",
];

export interface ScannerConfigPlugin {
  setSymbologies(options: { enabled: string[] }): Promise<void>;
  restoreAll(): Promise<void>;
}

export const ScannerConfig = registerPlugin<ScannerConfigPlugin>("ScannerConfig", {
  web: () =>
    Promise.resolve({
      async setSymbologies(): Promise<void> {},
      async restoreAll(): Promise<void> {},
    } as ScannerConfigPlugin),
});

// Serialize apply/restore so page-leave restoreAll and page-enter apply can't
// interleave into a stale state.
let lastOp: Promise<void> = Promise.resolve();

function enqueue(op: () => Promise<void>): void {
  lastOp = lastOp.then(op).catch((e) => console.warn("[ScannerConfig]", e));
}

/** Crash recovery: undo any restriction a previous app run left behind. */
export function restoreScannerSymbologies(): void {
  enqueue(() => ScannerConfig.restoreAll());
}

/**
 * Restrict the hardware decoder to the supplier profile's barcode-type
 * whitelist while the calling screen is mounted. Suppliers without a
 * whitelist leave the device untouched; unmounting after a restriction was
 * applied restores the full symbology set.
 */
export function useSupplierSymbologyScope(supplierCode: Ref<string | undefined>) {
  const warehouse = useWarehouse();
  let applied = false;

  async function applyFor(code: string | undefined): Promise<void> {
    const templates = await getCachedSupplierQrTemplates(warehouse);
    const whitelist = code
      ? templates.find((t) => t.code === code)?.barcodeTypes
      : null;
    if (whitelist && whitelist.length > 0) {
      await ScannerConfig.setSymbologies({ enabled: [...whitelist] });
      applied = true;
    } else if (applied) {
      await ScannerConfig.restoreAll();
      applied = false;
    }
  }

  watch(supplierCode, (code) => enqueue(() => applyFor(code)), { immediate: true });

  onUnmounted(() => {
    if (applied) {
      applied = false;
      enqueue(() => ScannerConfig.restoreAll());
    }
  });
}
