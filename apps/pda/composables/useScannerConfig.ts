import { registerPlugin } from "@capacitor/core";

// NOTE (Phase 1 port): useBrandSymbologyScope / useSupplierSymbologyScope are
// intentionally not ported yet — they depend on useWarehouse + useLabelScan,
// which arrive with the flow pages in a later phase.

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
 * Warehouse shelf/box labels are QR codes. Screens that need shelf scans
 * (picking scan session, put-away) always leave these symbologies enabled on
 * the decoder — label CONTENT validation is software-side, so allowing the
 * decoder to read QR does not weaken the supplier-label whitelist.
 */
export const SHELF_CODE_SYMBOLOGIES: readonly string[] = ["QR CODE"];

/** Union a supplier whitelist with the shelf-code symbologies (null passes through). */
export function withShelfSymbologies(whitelist: string[] | null): string[] | null {
  if (!whitelist) return whitelist;
  return [...new Set([...whitelist, ...SHELF_CODE_SYMBOLOGIES])];
}

/**
 * Union of the barcode-type whitelists of the supplier profiles covering the
 * given brands (parts.brand). Returns null — no restriction — when the brand
 * list is empty or ANY brand has no whitelisted profile (its labels'
 * symbology is unknown, so restricting could block them).
 */
export function brandWhitelistUnion(
  templates: { brands?: string[] | null; barcodeTypes?: string[] | null }[],
  brands: string[]
): string[] | null {
  if (brands.length === 0) return null;
  const enabled = new Set<string>();
  for (const brand of brands) {
    const whitelist = templates
      .filter((t) => t.brands?.includes(brand))
      .flatMap((t) => t.barcodeTypes ?? []);
    if (whitelist.length === 0) return null;
    for (const w of whitelist) enabled.add(w);
  }
  return enabled.size > 0 ? [...enabled] : null;
}

