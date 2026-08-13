import { describe, it, expect, beforeEach, vi } from 'vitest';

// useFlowSteps relies on Nuxt auto-imports (ref/readonly/useAuth/useWarehouse);
// stub them as globals before importing the module (vue is not directly
// resolvable here — same reason other composable tests mock it).
const getFlowConfigMock = vi.fn();
const currentUser = { value: { id: 'u1' } as { id: string } | null };

vi.stubGlobal('ref', <T>(value: T) => ({ value }));
vi.stubGlobal('readonly', <T>(r: { value: T }) => r);
vi.stubGlobal('useAuth', () => ({ currentUser }));
vi.stubGlobal('useWarehouse', () => ({ getFlowConfig: getFlowConfigMock }));

// The module keeps shared state at module level — re-import per test.
async function freshUseFlowSteps() {
  vi.resetModules();
  return (await import('../composables/useFlowSteps')).useFlowSteps();
}

describe('useFlowSteps putAway config', () => {
  beforeEach(() => {
    getFlowConfigMock.mockReset();
    currentUser.value = { id: 'u1' };
  });

  it('defaults to manual mode before the config fetch resolves', async () => {
    const { putAwayConfig } = await freshUseFlowSteps();

    expect(putAwayConfig.value).toEqual({
      autoCreateTasks: false,
      suggestShelf: 'existing-stock',
    });
  });

  it('merges the resolved putAway config (drives the put-away list-source switch)', async () => {
    getFlowConfigMock.mockResolvedValue({
      flowSteps: { 'put-away': false },
      putAway: { autoCreateTasks: true, suggestShelf: 'off' },
    });
    const { putAwayConfig, flowSteps, loadFlowSteps } = await freshUseFlowSteps();

    await loadFlowSteps();

    expect(putAwayConfig.value).toEqual({ autoCreateTasks: true, suggestShelf: 'off' });
    expect(flowSteps.value['put-away']).toBe(false);
  });

  it('merges the resolved pickingAllocation config (drives the receiving-detail picking tab)', async () => {
    getFlowConfigMock.mockResolvedValue({
      flowSteps: {},
      pickingAllocation: { allowDockStock: false },
    });
    const { pickingAllocation, loadFlowSteps } = await freshUseFlowSteps();

    expect(pickingAllocation.value.allowDockStock).toBe(true); // default before fetch
    await loadFlowSteps();
    expect(pickingAllocation.value.allowDockStock).toBe(false);
  });

  it('keeps the defaults when the backend omits the putAway section', async () => {
    getFlowConfigMock.mockResolvedValue({ flowSteps: {} });
    const { putAwayConfig, loadFlowSteps } = await freshUseFlowSteps();

    await loadFlowSteps();

    expect(putAwayConfig.value).toEqual({
      autoCreateTasks: false,
      suggestShelf: 'existing-stock',
    });
  });

  it('keeps the defaults when the config fetch fails', async () => {
    getFlowConfigMock.mockRejectedValue(new Error('offline'));
    const { putAwayConfig, loadFlowSteps } = await freshUseFlowSteps();

    await loadFlowSteps();

    expect(putAwayConfig.value.autoCreateTasks).toBe(false);
  });

  it('does not fetch while logged out', async () => {
    currentUser.value = null;
    const { loadFlowSteps } = await freshUseFlowSteps();

    await loadFlowSteps();

    expect(getFlowConfigMock).not.toHaveBeenCalled();
  });
});
