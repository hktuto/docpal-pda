import type { OutdatedScanWarning } from "./types";

/**
 * Scan-warning wiring (same module-level pattern as apiClient's
 * setTokenGetter): the adapter calls emitOutdatedWarning for every scan
 * response carrying a warning; the useOutdatedWarning composable registers
 * the handler once at module load (it is imported by the always-mounted
 * OutdatedWarningDialog). Keeps the service layer vue-free so the plain
 * vitest runtime can import it.
 */
let handler: ((warning: OutdatedScanWarning) => void) | null = null;

export function setOutdatedWarningHandler(fn: (warning: OutdatedScanWarning) => void): void {
  handler = fn;
}

export function emitOutdatedWarning(warning: OutdatedScanWarning | null | undefined): void {
  if (warning) handler?.(warning);
}
