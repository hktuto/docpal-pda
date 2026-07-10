import { onMounted, onUnmounted, ref } from 'vue';

export interface UseHardwareScannerOptions {
  /** Called with the full scanned string when Enter is pressed. */
  onScan: (value: string) => void | Promise<void>;
  /**
   * Additional guard to disable scanning (e.g. while a modal is open).
   * The listener already skips input/textarea/select/contenteditable elements.
   */
  enabled?: () => boolean;
  /** How long to wait after the last keystroke before clearing the buffer. */
  idleTimeoutMs?: number;
  /**
   * Optional predicate to ignore a keystroke (e.g. ignore function keys that
   * some scanner models emit as prefix/suffix characters).
   */
  ignoreKey?: (event: KeyboardEvent) => boolean;
}

function isInputElement(target: EventTarget | null): boolean {
  if (target == null || typeof target !== 'object') return false;
  const el = target as Record<string, unknown>;
  const tagName = String(el.tagName ?? '').toLowerCase();
  if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') {
    return true;
  }
  return Boolean(el.isContentEditable);
}

export function useHardwareScanner(options: UseHardwareScannerOptions) {
  const buffer = ref('');
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  function resetIdleTimer() {
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      buffer.value = '';
    }, options.idleTimeoutMs ?? 300);
  }

  async function flush() {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    const value = buffer.value;
    buffer.value = '';
    if (!value) return;
    console.log('[SCAN-TIME] hardware flush:', value);
    const start = performance.now();
    await options.onScan(value);
    console.log('[SCAN-TIME] onScan done in', (performance.now() - start).toFixed(1), 'ms');
  }

  function onKeydown(event: KeyboardEvent) {
    if (options.enabled && !options.enabled()) return;
    if (event.repeat) return;
    if (event.isComposing) return;
    if (isInputElement(event.target)) return;
    if (options.ignoreKey && options.ignoreKey(event)) return;

    if (event.key === 'Enter') {
      if (buffer.value) {
        event.preventDefault();
        void flush();
      }
      return;
    }

    // Ignore lone modifier / function keys. Printable keys have `key.length === 1`.
    if (event.key.length !== 1) return;

    event.preventDefault();
    resetIdleTimer();
    buffer.value += event.key;
  }

  onMounted(() => {
    window.addEventListener('keydown', onKeydown, { capture: true });
  });

  onUnmounted(() => {
    window.removeEventListener('keydown', onKeydown, { capture: true });
    if (timeoutId) clearTimeout(timeoutId);
  });

  return { buffer };
}
