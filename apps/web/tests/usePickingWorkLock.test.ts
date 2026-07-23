import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiError } from '../services/apiClient';

const mountedCbs: Array<() => void> = [];
const unmountedCbs: Array<() => void> = [];

vi.mock('vue', () => ({
  ref: vi.fn((value: unknown) => ({ value })),
  onMounted: vi.fn((fn: () => void) => mountedCbs.push(fn)),
  onUnmounted: vi.fn((fn: () => void) => unmountedCbs.push(fn)),
}));

const currentRoute = { value: { path: '/picking/ORDER-1' } };
vi.mock('vue-router', () => ({
  useRouter: () => ({ currentRoute }),
}));

const acquireMock = vi.fn<() => Promise<{ orderId: string; workingBy: string }>>();
const releaseMock = vi.fn();
vi.mock('../composables/useWarehouse', () => ({
  useWarehouse: () => ({
    acquirePickingWorkLock: acquireMock,
    releasePickingWorkLock: releaseMock,
  }),
}));

const { usePickingWorkLock } = await import('../composables/usePickingWorkLock');

function mount() {
  const lock = usePickingWorkLock('ORDER-1');
  mountedCbs.forEach((fn) => fn());
  return lock;
}

function unmount() {
  unmountedCbs.forEach((fn) => fn());
}

describe('usePickingWorkLock', () => {
  let listeners: Record<string, Array<() => void>>;

  beforeEach(async () => {
    vi.useFakeTimers();
    mountedCbs.length = 0;
    unmountedCbs.length = 0;
    acquireMock.mockReset().mockResolvedValue({ orderId: 'ORDER-1', workingBy: 'u1' });
    releaseMock.mockReset();
    currentRoute.value.path = '/picking/ORDER-1';
    listeners = {};
    // @ts-expect-error replacing window for unit testing
    globalThis.window = {
      addEventListener: vi.fn((type: string, fn: () => void) => {
        (listeners[type] ??= []).push(fn);
      }),
      removeEventListener: vi.fn(),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('acquires on mount and refreshes every 3 minutes', async () => {
    const lock = mount();
    await vi.advanceTimersByTimeAsync(0);
    expect(acquireMock).toHaveBeenCalledTimes(1);
    expect(lock.acquired.value).toBe(true);
    expect(lock.heldByOther.value).toBeNull();

    await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
    expect(acquireMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
    expect(acquireMock).toHaveBeenCalledTimes(3);
  });

  it('releases on unmount when navigating away from the order', async () => {
    const lock = mount();
    await vi.advanceTimersByTimeAsync(0);
    expect(lock.acquired.value).toBe(true);

    currentRoute.value.path = '/picking'; // left the order entirely
    unmount();
    expect(releaseMock).toHaveBeenCalledWith('ORDER-1');
  });

  it('keeps the lock when moving between the detail and scan pages of the same order', async () => {
    const lock = mount();
    await vi.advanceTimersByTimeAsync(0);

    currentRoute.value.path = '/picking/scan/ORDER-1';
    unmount();
    expect(releaseMock).not.toHaveBeenCalled();
  });

  it('releases on pagehide (app close)', async () => {
    const lock = mount();
    await vi.advanceTimersByTimeAsync(0);
    expect(lock.acquired.value).toBe(true);

    listeners['pagehide']?.forEach((fn) => fn());
    expect(releaseMock).toHaveBeenCalledWith('ORDER-1');
  });

  it('409 lock_held marks the order held by another user; unmount does not release', async () => {
    acquireMock.mockRejectedValue(new ApiError('409', 409, { error: 'lock_held', holderName: 'Alice' }));
    const lock = mount();
    await vi.advanceTimersByTimeAsync(0);

    expect(lock.acquired.value).toBe(false);
    expect(lock.heldByOther.value).toBe('Alice');

    currentRoute.value.path = '/picking';
    unmount();
    expect(releaseMock).not.toHaveBeenCalled();
  });

  it('non-409 acquire failures leave the page usable and retry on the next refresh', async () => {
    acquireMock.mockRejectedValueOnce(new Error('network'));
    const lock = mount();
    await vi.advanceTimersByTimeAsync(0);
    expect(lock.acquired.value).toBe(false);
    expect(lock.heldByOther.value).toBeNull();

    await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
    expect(acquireMock).toHaveBeenCalledTimes(2);
    expect(lock.acquired.value).toBe(true);
  });
});
