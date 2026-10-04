import { describe, it, expect, beforeEach, vi } from 'vitest';

// useViewConfig/useFlowSteps rely on Nuxt auto-imports; stub them as globals
// (same pattern as tests/useFlowSteps.test.ts).
const getFlowConfigMock = vi.fn();
const currentUser = { value: { id: 'u1' } as { id: string } | null };

vi.stubGlobal('ref', <T>(value: T) => ({ value }));
vi.stubGlobal('readonly', <T>(r: { value: T }) => r);
vi.stubGlobal('useAuth', () => ({ currentUser }));
vi.stubGlobal('useWarehouse', () => ({ getFlowConfig: getFlowConfigMock }));
vi.stubGlobal('useI18n', () => ({ t: (key: string) => key }));
vi.stubGlobal('useStatusLabel', () => ({ receiving: (s: string) => `receiving:${s}` }));

async function freshModules() {
  vi.resetModules();
  const viewConfigModule = await import('../composables/useViewConfig');
  const flowSteps = (await import('../composables/useFlowSteps')).useFlowSteps();
  return { ...viewConfigModule.useViewConfig(), ...flowSteps };
}

describe('useFlowSteps → viewConfig', () => {
  beforeEach(() => {
    getFlowConfigMock.mockReset();
    currentUser.value = { id: 'u1' };
  });

  it('applies the resolved viewConfig and flags it loaded', async () => {
    getFlowConfigMock.mockResolvedValue({
      flowSteps: {},
      viewConfig: {
        lists: { receiving: { title: '[batch_no]', meta: ['[supplier_name]', '[delivery_date]'], chip: 'remaining_items' } },
        receivingDetail: { defaultGrouping: 'carton', itemFields: ['wcl_item_no'] },
      },
    });
    const { viewConfig, viewConfigLoaded, loadFlowSteps } = await freshModules();

    expect(viewConfigLoaded.value).toBe(false);
    expect(viewConfig.value.lists.receiving.chip).toBe('status');
    await loadFlowSteps();

    expect(viewConfigLoaded.value).toBe(true);
    expect(viewConfig.value.lists.receiving).toEqual({
      title: '[batch_no]',
      meta: ['[supplier_name]', '[delivery_date]'],
      chip: 'remaining_items',
    });
    expect(viewConfig.value.receivingDetail.defaultGrouping).toBe('carton');
    expect(viewConfig.value.receivingDetail.itemFields).toEqual(['wcl_item_no']);
    // untouched sections keep the defaults
    expect(viewConfig.value.lists.picking.title).toBe('[order_no]');
    expect(viewConfig.value.receivingDetail.expandedFields.length).toBeGreaterThan(0);
  });

  it('maps legacy listTemplates into the lists when viewConfig is absent', async () => {
    getFlowConfigMock.mockResolvedValue({
      flowSteps: {},
      listTemplates: { receiving: { meta: '[invoice_no]' } },
    });
    const { viewConfig, viewConfigLoaded, loadFlowSteps } = await freshModules();

    await loadFlowSteps();

    expect(viewConfigLoaded.value).toBe(false);
    expect(viewConfig.value.lists.receiving).toEqual({
      title: '[name]',
      meta: ['[invoice_no]'],
      chip: 'status',
    });
  });

  it('rejects malformed meta arrays (falls back to the default meta)', async () => {
    getFlowConfigMock.mockResolvedValue({
      flowSteps: {},
      viewConfig: { lists: { receiving: { meta: [] } } },
    });
    const { viewConfig, loadFlowSteps } = await freshModules();

    await loadFlowSteps();

    expect(viewConfig.value.lists.receiving.meta).toEqual(['[supplier_name] · [delivery_date]']);
  });
});
