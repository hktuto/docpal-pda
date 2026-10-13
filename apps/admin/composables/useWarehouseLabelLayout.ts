import type { LabelLayout } from "~/utils/print";

/**
 * Warehouse-specific label layout. Fetches the backend's /config once to get
 * the instance's warehouseCode (WAREHOUSE_CODE env), then exposes the label
 * layout for that warehouse. SZ gets a 3px border for easy cutting;
 * other warehouses (HK) use the default borderless layout.
 */
export function useWarehouseLabelLayout() {
  const config = useRuntimeConfig();
  const layout = ref<LabelLayout>({});

  onMounted(async () => {
    try {
      // /config sits behind the auth middleware — send the admin JWT like
      // every other admin request (a bare fetch gets a silent 401).
      const token = import.meta.client ? localStorage.getItem("admin_token") : null;
      const res = await fetch(`${config.public.apiBaseUrl}/config`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
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
