import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ref = vi.fn((value: string) => ({ value }));
const onMounted = vi.fn((fn: () => void) => fn());
const onUnmounted = vi.fn();

vi.mock('vue', () => ({
  ref,
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

const { useHardwareScanner } = await import('../composables/useHardwareScanner');

describe('useHardwareScanner', () => {
  let handler: ReturnType<typeof vi.fn>;
  let registeredHandler: ((event: KeyboardEvent) => void) | null = null;
  let fakeWindow: {
    addEventListener: ReturnType<typeof vi.fn>;
    removeEventListener: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    handler = vi.fn();
    registeredHandler = null;
    scanListeners.length = 0;
    addListenerMock.mockClear();
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

  it('registers a keydown listener on mount', () => {
    useHardwareScanner({ onScan: handler });
    expect(fakeWindow.addEventListener).toHaveBeenCalledWith('keydown', expect.any(Function), { capture: true });
  });

  it('collects printable keys and flushes on Enter', async () => {
    useHardwareScanner({ onScan: handler });
    keydown('A');
    keydown('B');
    keydown('1');
    keydown('Enter');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(handler).toHaveBeenCalledWith('AB1');
  });

  it('ignores keys while focus is inside an input', async () => {
    useHardwareScanner({ onScan: handler });
    keydown('A', { tagName: 'INPUT' } as unknown as EventTarget);
    keydown('Enter', { tagName: 'INPUT' } as unknown as EventTarget);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(handler).not.toHaveBeenCalled();
  });

  it('ignores function and modifier keys', async () => {
    useHardwareScanner({ onScan: handler });
    keydown('Shift');
    keydown('F1');
    keydown('ArrowDown');
    keydown('Enter');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(handler).not.toHaveBeenCalled();
  });

  it('does not scan when disabled guard returns false', async () => {
    useHardwareScanner({ onScan: handler, enabled: () => false });
    keydown('X');
    keydown('Enter');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(handler).not.toHaveBeenCalled();
  });

  function broadcast(value: string) {
    scanListeners.forEach((cb) => cb({ value }));
  }

  it('delivers broadcast scans without key buffering', async () => {
    useHardwareScanner({ onScan: handler });
    broadcast('BC123');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(handler).toHaveBeenCalledWith('BC123');
  });

  it('honours the enabled guard for broadcast scans', async () => {
    useHardwareScanner({ onScan: handler, enabled: () => false });
    broadcast('BC123');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(handler).not.toHaveBeenCalled();
  });

  it('clears the wedge buffer and eats the wedge echo after a broadcast scan', async () => {
    useHardwareScanner({ onScan: handler });
    keydown('A');
    keydown('B');
    broadcast('BC123');
    const echoChar = keydown('C');
    const echoEnter = keydown('Enter');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith('BC123');
    expect(echoChar.preventDefault).toHaveBeenCalled();
    expect(echoEnter.preventDefault).toHaveBeenCalled();
  });

  it('accepts wedge input again after the suppression window', async () => {
    vi.useFakeTimers();
    try {
      useHardwareScanner({ onScan: handler });
      broadcast('BC123');
      await vi.advanceTimersByTimeAsync(0);
      vi.advanceTimersByTime(1600);
      keydown('X');
      keydown('Enter');
      await vi.advanceTimersByTimeAsync(0);
      expect(handler).toHaveBeenCalledWith('BC123');
      expect(handler).toHaveBeenCalledWith('X');
      expect(handler).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  function fakeInput(marked: boolean) {
    return {
      tagName: 'INPUT',
      value: '',
      isContentEditable: false,
      hasAttribute: (name: string) => marked && name === 'data-scan-fill',
      dispatchEvent: vi.fn(),
    };
  }

  function withFocusedElement(el: unknown, fn: () => Promise<void>) {
    const original = (globalThis as Record<string, unknown>).document;
    (globalThis as Record<string, unknown>).document = { activeElement: el };
    return fn().finally(() => {
      if (original === undefined) delete (globalThis as Record<string, unknown>).document;
      else (globalThis as Record<string, unknown>).document = original;
    });
  }

  it('fills a focused data-scan-fill input instead of running onScan', async () => {
    const input = fakeInput(true);
    await withFocusedElement(input, async () => {
      useHardwareScanner({ onScan: handler });
      broadcast('BC123');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(input.value).toBe('BC123');
    expect(input.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'input' }));
    expect(handler).not.toHaveBeenCalled();
  });

  it('runs onScan when the focused input is not marked data-scan-fill', async () => {
    const input = fakeInput(false);
    await withFocusedElement(input, async () => {
      useHardwareScanner({ onScan: handler });
      broadcast('BC123');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(input.value).toBe('');
    expect(handler).toHaveBeenCalledWith('BC123');
  });

  it('runs onScan when nothing is focused', async () => {
    await withFocusedElement(null, async () => {
      useHardwareScanner({ onScan: handler });
      broadcast('BC123');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(handler).toHaveBeenCalledWith('BC123');
  });

  it('ignores keys matched by ignoreKey predicate', async () => {
    useHardwareScanner({ onScan: handler, ignoreKey: (event) => event.key === '!' });
    keydown('A');
    keydown('!');
    keydown('B');
    keydown('Enter');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(handler).toHaveBeenCalledWith('AB');
  });
});
