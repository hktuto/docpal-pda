import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setCached, getCached, clearApiCache } from '~/services/apiCache';
import { useWarehouseEvents } from '~/composables/useWarehouseEvents';

const { showToastMock } = vi.hoisted(() => ({ showToastMock: vi.fn() }));

vi.mock('~/composables/useToast', () => ({
  useToast: () => ({ showToast: showToastMock }),
}));

// vue is not a direct dependency of @warehouse/web (pnpm does not hoist it),
// so mock it like tests/useHardwareScanner.test.ts does.
vi.mock('vue', () => ({
  ref: (value: unknown) => ({ value }),
  readonly: <T>(x: T): T => x,
}));

class MockEventSource {
  static instances: MockEventSource[] = [];

  readonly url: string;
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, ((ev: MessageEvent) => void)[]>();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, cb: (ev: MessageEvent) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(cb);
    this.listeners.set(type, list);
  }

  close() {
    this.closed = true;
  }

  // Test helpers
  open() {
    this.onopen?.();
  }

  error() {
    this.onerror?.();
  }

  emit(type: string, payload: unknown, lastEventId: string) {
    for (const cb of this.listeners.get(type) ?? []) {
      cb({ data: JSON.stringify(payload), lastEventId } as MessageEvent);
    }
  }
}

function createLocalStorageFake(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => map.delete(key),
    setItem: (key: string, value: string) => map.set(key, value),
  };
}

function makeEvent(
  id: number,
  type: string,
  topics: string[],
  data: Record<string, unknown> = {}
) {
  return { id, type, topics, data, createdDate: new Date(0).toISOString() };
}

describe('useWarehouseEvents', () => {
  let storage: Storage;

  beforeEach(() => {
    storage = createLocalStorageFake();
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('EventSource', MockEventSource);
    vi.stubGlobal('useRuntimeConfig', () => ({
      public: { apiBaseUrl: 'http://api.test' },
    }));
    // The i18n stub returns the key, so toast assertions read as keys.
    vi.stubGlobal('useNuxtApp', () => ({ $i18n: { t: (key: string) => key } }));
    // The stream carries the JWT as a query param — sign in by default.
    storage.setItem('warehouse-token', 'jwt-1');
    MockEventSource.instances = [];
    showToastMock.mockReset();
    clearApiCache();
  });

  afterEach(() => {
    useWarehouseEvents().disconnect();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('connects to /events with the ?since= cursor from storage and the session token', () => {
    storage.setItem('wms-events-last-id', '41');

    useWarehouseEvents().connect();

    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0].url).toBe('http://api.test/events?since=41&token=jwt-1');
  });

  it('does not connect without a session token', () => {
    storage.removeItem('warehouse-token');

    useWarehouseEvents().connect();

    expect(MockEventSource.instances).toHaveLength(0);
  });

  it('connect() is a no-op while already connected', () => {
    const events = useWarehouseEvents();
    events.connect();
    events.connect();

    expect(MockEventSource.instances).toHaveLength(1);
  });

  it('a message persists the cursor, notifies matching subscribers and invalidates the cache', () => {
    const events = useWarehouseEvents();
    events.connect();
    const source = MockEventSource.instances[0];

    const received: unknown[] = [];
    const unsubscribe = events.subscribe(['/picking-orders'], (e) => received.push(e));
    const otherCb = vi.fn();
    const unsubscribeOther = events.subscribe(['/receiving-orders'], otherCb);
    setCached('http://api.test/picking-orders?status=open', [1]);

    const payload = makeEvent(42, 'picking_order.updated', ['/picking-orders']);
    source.emit('picking_order.updated', payload, '42');

    expect(storage.getItem('wms-events-last-id')).toBe('42');
    expect(received).toEqual([payload]);
    expect(otherCb).not.toHaveBeenCalled();
    expect(getCached('http://api.test/picking-orders?status=open')).toBeNull();
    // picking_order.updated is not a toastable type
    expect(showToastMock).not.toHaveBeenCalled();

    unsubscribe();
    unsubscribeOther();
  });

  it('unsubscribed pages stop receiving events', () => {
    const events = useWarehouseEvents();
    events.connect();
    const source = MockEventSource.instances[0];

    const cb = vi.fn();
    const unsubscribe = events.subscribe(['/picking-orders'], cb);
    unsubscribe();

    source.emit('picking_order.updated', makeEvent(5, 'picking_order.updated', ['/picking-orders']), '5');
    expect(cb).not.toHaveBeenCalled();
  });

  it('on error it closes and reconnects with backoff using the persisted cursor', () => {
    vi.useFakeTimers();
    const events = useWarehouseEvents();
    events.connect();
    const first = MockEventSource.instances[0];
    first.open();
    expect(events.connected.value).toBe(true);

    first.emit('picking_order.updated', makeEvent(7, 'picking_order.updated', ['/picking-orders']), '7');
    first.error();

    expect(first.closed).toBe(true);
    expect(events.connected.value).toBe(false);
    expect(MockEventSource.instances).toHaveLength(1);

    // First retry after 2 s, with the cursor from the last received event.
    vi.advanceTimersByTime(2000);
    expect(MockEventSource.instances).toHaveLength(2);
    const second = MockEventSource.instances[1];
    expect(second.url).toBe('http://api.test/events?since=7&token=jwt-1');

    // Backoff grows ×1.5: next retry after 3 s.
    second.error();
    vi.advanceTimersByTime(2999);
    expect(MockEventSource.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(MockEventSource.instances).toHaveLength(3);
  });

  it('shows a toast with a navigation action for toastable event types', () => {
    const events = useWarehouseEvents();
    events.connect();
    const source = MockEventSource.instances[0];

    source.emit(
      'allocation.computed',
      makeEvent(3, 'allocation.computed', ['/picking-orders']),
      '3'
    );
    expect(showToastMock).toHaveBeenCalledTimes(1);
    expect(showToastMock).toHaveBeenCalledWith('event_allocation_computed', {
      action: { label: 'view', to: '/picking' },
    });

    source.emit(
      'goods_verify.tasks_created',
      makeEvent(4, 'goods_verify.tasks_created', ['/goods-verify-tasks'], { count: 2 }),
      '4'
    );
    expect(showToastMock).toHaveBeenCalledTimes(2);
    expect(showToastMock).toHaveBeenLastCalledWith('event_goods_verify_tasks_created', {
      action: { label: 'view', to: '/goods-verify' },
    });
  });

  it('shows no toast for non-toastable types', () => {
    const events = useWarehouseEvents();
    events.connect();
    const source = MockEventSource.instances[0];

    source.emit(
      'receiving_order.upserted',
      makeEvent(6, 'receiving_order.upserted', ['/receiving-orders']),
      '6'
    );

    expect(showToastMock).not.toHaveBeenCalled();
  });

  it('disconnect closes the stream and cancels a pending reconnect', () => {
    vi.useFakeTimers();
    const events = useWarehouseEvents();
    events.connect();
    const first = MockEventSource.instances[0];
    first.error();

    events.disconnect();

    expect(first.closed).toBe(true);
    expect(events.connected.value).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(MockEventSource.instances).toHaveLength(1);
  });
});
