import { describe, it, expect, beforeEach, vi } from 'vitest';

// usePageHeader relies on Nuxt auto-imports (useState/useRoute/computed);
// stub them as globals before importing the module (same pattern as
// useFlowSteps.test.ts — vue is not directly resolvable here).
const stateStore = new Map<string, { value: unknown }>();
const currentRoute = { fullPath: '/receiving/ORDER-1' };

vi.stubGlobal('useState', (key: string, init: () => unknown) => {
  if (!stateStore.has(key)) stateStore.set(key, { value: init() });
  return stateStore.get(key);
});
vi.stubGlobal('useRoute', () => currentRoute);
vi.stubGlobal('computed', <T>(fn: () => T) => ({
  get value() {
    return fn();
  },
}));

const { usePageHeader } = await import('../composables/usePageHeader');

describe('usePageHeader', () => {
  beforeEach(() => {
    stateStore.clear();
    currentRoute.fullPath = '/receiving/ORDER-1';
  });

  it('exposes the registered config while on the registering route', () => {
    const { active } = usePageHeader({ title: 'ORDER-1' });

    expect(active.value?.title).toBe('ORDER-1');
  });

  it('keeps getter fields live', () => {
    let status = 'pending';
    const { active } = usePageHeader({ badgeText: () => status });

    expect(active.value?.badgeText && (active.value.badgeText as () => string)()).toBe('pending');
    status = 'clear';
    expect((active.value?.badgeText as () => string)()).toBe('clear');
  });

  it('ignores the registration after navigating away (race-free clearing)', () => {
    usePageHeader({ title: 'ORDER-1' });

    currentRoute.fullPath = '/receiving';
    const { active } = usePageHeader();

    expect(active.value).toBeNull();
  });

  it('a later registration on the new route replaces the stale one', () => {
    usePageHeader({ title: 'ORDER-1' });

    currentRoute.fullPath = '/receiving/ORDER-2';
    const { active } = usePageHeader({ title: 'ORDER-2' });

    expect(active.value?.title).toBe('ORDER-2');
  });

  it('reports nothing when no page registered', () => {
    const { active } = usePageHeader();

    expect(active.value).toBeNull();
  });
});
