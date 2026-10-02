import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const onMounted = vi.fn((fn: () => void) => fn());
const onUnmounted = vi.fn();

vi.mock('vue', () => ({
  onMounted,
  onUnmounted,
}));

const scanListeners: Array<(data: { value: string }) => void> = [];
const addListenerMock = vi.fn((_event: string, cb: (data: { value: string }) => void) => {
  scanListeners.push(cb);
  return Promise.resolve({ remove: vi.fn() });
});

vi.mock('../composables/useScannerBroadcast', () => ({
  ScannerBroadcast: { addListener: addListenerMock },
}));

const beeps: string[] = [];
vi.mock('../utils/scanBeep', () => ({
  playScanSuccess: () => beeps.push('success'),
  playScanError: () => beeps.push('error'),
}));

// Redundant navigations (same route pushed twice) reject — like vue-router.
const pushMock = vi.fn((path: string) =>
  Promise.resolve(path)
);
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: pushMock }),
}));

const { useOrderScanNav } = await import('../composables/useOrderScanNav');

describe('useOrderScanNav', () => {
  let registeredHandler: ((event: KeyboardEvent) => void) | null = null;
  let fakeWindow: {
    addEventListener: ReturnType<typeof vi.fn>;
    removeEventListener: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    registeredHandler = null;
    scanListeners.length = 0;
    addListenerMock.mockClear();
    pushMock.mockClear();
    beeps.length = 0;
    fakeWindow = {
      addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
        if (type === 'keydown' && typeof listener === 'function') {
          registeredHandler = listener as (event: KeyboardEvent) => void;
        }
      }),
      removeEventListener: vi.fn(),
    };
    // @ts-expect-error replacing window for unit testing
    globalThis.window = fakeWindow;
  });

  afterEach(() => {
    registeredHandler = null;
    vi.restoreAllMocks();
  });

  function keydown(key: string, target?: EventTarget | null) {
    const event = { key, target, preventDefault: vi.fn(), isComposing: false, repeat: false } as unknown as KeyboardEvent;
    registeredHandler?.(event);
    return event;
  }

  function broadcast(value: string) {
    scanListeners.forEach((cb) => cb({ value }));
  }

  it('registers a capture keydown listener and a broadcast listener on mount', () => {
    useOrderScanNav();
    expect(fakeWindow.addEventListener).toHaveBeenCalledWith('keydown', expect.any(Function), { capture: true });
    expect(addListenerMock).toHaveBeenCalledWith('scan', expect.any(Function));
  });

  it('navigates to the picking scan session on a broadcast order-link scan', async () => {
    useOrderScanNav();
    broadcast('warehouse://picking/abc-123');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pushMock).toHaveBeenCalledWith('/picking/scan/abc-123');
    expect(beeps).toEqual(['success']);
  });

  it('navigates to the receiving order on a broadcast order-link scan', async () => {
    useOrderScanNav();
    broadcast('warehouse://receiving/def-456');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pushMock).toHaveBeenCalledWith('/receiving/def-456');
  });

  it('ignores non-order-link broadcast scans silently', async () => {
    useOrderScanNav();
    broadcast('RK73H1JTTD1002F');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pushMock).not.toHaveBeenCalled();
    expect(beeps).toEqual([]);
  });

  it('navigates on a wedged order-link scan, swallowing only its keystrokes', async () => {
    useOrderScanNav();
    for (const ch of 'warehouse://picking/abc-123') keydown(ch);
    const enter = keydown('Enter');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pushMock).toHaveBeenCalledWith('/picking/scan/abc-123');
    expect(enter.preventDefault).toHaveBeenCalled();
  });

  it('does not swallow keystrokes of non-order-link scans', async () => {
    useOrderScanNav();
    const r = keydown('R');
    const k = keydown('K');
    expect(r.preventDefault).not.toHaveBeenCalled();
    expect(k.preventDefault).not.toHaveBeenCalled();
  });

  it('ignores wedged keys while focus is inside an input', async () => {
    useOrderScanNav();
    for (const ch of 'warehouse://picking/abc-123') keydown(ch, { tagName: 'INPUT' } as unknown as EventTarget);
    keydown('Enter', { tagName: 'INPUT' } as unknown as EventTarget);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('skips broadcast navigation while a scan-fill input is focused', async () => {
    const original = (globalThis as Record<string, unknown>).document;
    (globalThis as Record<string, unknown>).document = {
      activeElement: { tagName: 'INPUT', isContentEditable: false },
    };
    try {
      useOrderScanNav();
      broadcast('warehouse://picking/abc-123');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(pushMock).not.toHaveBeenCalled();
      expect(beeps).toEqual([]);
    } finally {
      if (original === undefined) delete (globalThis as Record<string, unknown>).document;
      else (globalThis as Record<string, unknown>).document = original;
    }
  });

  it('survives a rejected (redundant) navigation', async () => {
    pushMock.mockRejectedValueOnce(new Error('Avoided redundant navigation'));
    useOrderScanNav();
    broadcast('warehouse://picking/abc-123');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pushMock).toHaveBeenCalled();
  });
});
