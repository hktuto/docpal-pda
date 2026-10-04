// Global order-link QR navigation, mounted once in app.vue so scanning an
// admin shipper / picking-list order QR works from EVERY page (home, order
// lists, and pages without their own useHardwareScanner), on both scan
// transports (broadcast + keyboard wedge). Page-level useHardwareScanner
// instances keep a skip-guard so the same scan never reaches a page's
// onScan handler as a bogus part scan.
//
// Spec: docs/superpowers/specs/2026-10-02-excel-order-barcode-scan-to-open-design.md

import { onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import type { PluginListenerHandle } from '@capacitor/core';
import { ScannerBroadcast } from './useScannerBroadcast';
import { playScanSuccess } from '~/utils/scanBeep';
import { ORDER_SCAN_PREFIX, resolveOrderScanRoute } from '~/utils/orderScanRoute';

/** After a broadcast scan, consume wedge key echo for this long (ms). */
const WEDGE_SUPPRESS_MS = 1500;
const IDLE_FLUSH_MS = 300;

function isInputElement(target: EventTarget | null): boolean {
  if (target == null || typeof target !== 'object') return false;
  const el = target as Record<string, unknown>;
  const tagName = String(el.tagName ?? '').toLowerCase();
  if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') return true;
  return Boolean(el.isContentEditable);
}

export function useOrderScanNav() {
  const router = useRouter();
  let buffer = '';
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let suppressWedgeUntil = 0;
  let broadcastHandle: PluginListenerHandle | null = null;
  let unmounted = false;

  function navigate(value: string): boolean {
    const path = resolveOrderScanRoute(value);
    if (!path) return false;
    // Redundant navigations (same order scanned twice) reject — ignore.
    void router.push(path).catch(() => {});
    playScanSuccess();
    return true;
  }

  function resetIdleTimer() {
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      buffer = '';
    }, IDLE_FLUSH_MS);
  }

  function clearIdleTimer() {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  }

  // Broadcast scan: the whole payload arrives in one event.
  async function onBroadcastScan(value: string) {
    clearIdleTimer();
    buffer = '';
    // A scan-fill input consumes the scan as field text — no navigation.
    const active = typeof document === 'undefined' ? null : document.activeElement;
    if (isInputElement(active)) return;
    suppressWedgeUntil = Date.now() + WEDGE_SUPPRESS_MS;
    navigate(value);
  }

  // Keyboard wedge: buffer printable keys only while they can still form an
  // order link (a prefix of "warehouse://", or past the prefix heading for
  // the id), so normal typing/scan keys on pages without their own scanner
  // composable pass through untouched.
  function onKeydown(event: KeyboardEvent) {
    if (event.repeat || event.isComposing) return;
    if (isInputElement(event.target)) return;
    if (Date.now() < suppressWedgeUntil) return;
    if (event.key === 'Enter') {
      const value = buffer;
      buffer = '';
      clearIdleTimer();
      if (value) {
        event.preventDefault();
        navigate(value);
      }
      return;
    }
    if (event.key.length !== 1) return;
    buffer += event.key;
    if (ORDER_SCAN_PREFIX.startsWith(buffer) || buffer.startsWith(ORDER_SCAN_PREFIX)) {
      event.preventDefault();
      resetIdleTimer();
    } else {
      // Not an order link — leave the keys to the page.
      buffer = '';
      clearIdleTimer();
    }
  }

  onMounted(() => {
    window.addEventListener('keydown', onKeydown, { capture: true });
    void ScannerBroadcast.addListener('scan', (data) => {
      void onBroadcastScan(data.value);
    }).then((handle) => {
      if (unmounted) void handle.remove();
      else broadcastHandle = handle;
    });
  });

  onUnmounted(() => {
    unmounted = true;
    window.removeEventListener('keydown', onKeydown, { capture: true });
    clearIdleTimer();
    if (broadcastHandle) {
      void broadcastHandle.remove();
      broadcastHandle = null;
    }
  });
}
