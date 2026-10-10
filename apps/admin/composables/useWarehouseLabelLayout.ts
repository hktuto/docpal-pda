import type { LabelLayout } from "~/utils/print";

/**
 * Warehouse-specific label layout. Fetches the backend's /config once to get
 * the instance's warehouseCode (WAREHOUSE_CODE env), then exposes the label
 * layout for that warehouse. SZ gets a light border for easy cutting; other
 * warehouses (HK) use the default borderless layout.
 */
export function useWarehouseLabelLayout() {
  const config = useRuntimeConfig();
  const layout = ref<LabelLayout>({});

  onMounted(async () => {
    try {
      const res = await fetch(`${config.public.apiBaseUrl}/config`);
      if (res.ok) {
        const data = await res.json();
        if (data.warehouseCode === "sz") {
          layout.value = { border: true };
        }
      }
    } catch {
      // fetch failed — keep default layout
    }
  });

  return { layout };
}
