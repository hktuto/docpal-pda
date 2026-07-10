import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ref = vi.fn((value: string) => ({ value }));
const onMounted = vi.fn((fn: () => void) => fn());
const onUnmounted = vi.fn();

vi.mock('vue', () => ({
  ref,
  onMounted,
  onUnmounted,
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
