import { setWarehouseLabelSizes, type LabelLayout } from "~/utils/print";

// One /config fetch per page load, shared by every caller: it carries the
// instance's warehouseCode, which decides both the label layout and the
// active label-size catalog (SZ: four sizes at 105%; HK: the die-cut
// 24-up A4 sheet). A failed fetch clears the cache so the next mount retries.
let configPromise: Promise<Record<string, unknown> | null> | null = null;

function fetchWarehouseConfig(apiBaseUrl: string): Promise<Record<string, unknown> | null> {
  configPromise ??= (async () => {
    try {
      // /config sits behind the auth middleware — send the admin JWT like
      // every other admin request (a bare fetch gets a silent 401).
      const token = import.meta.client ? localStorage.getItem("admin_token") : null;
      const res = await fetch(`${apiBaseUrl}/config`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        configPromise = null;
        return null;
      }
      return (await res.json()) as Record<string, unknown>;
    } catch {
      configPromise = null; // fetch failed — keep the defaults, retry next mount
      return null;
    }
  })();
  return configPromise;
}

/**
 * Warehouse-specific label layout + size catalog. Fetches the backend's
 * /config once to get the instance's warehouseCode (WAREHOUSE_CODE env),
 * then exposes the label layout for that warehouse. SZ gets a 3px border
 * for easy cutting; other warehouses (HK) use the default borderless
 * layout. Both the layout and the size catalog (setWarehouseLabelSizes)
 * land when the fetch resolves.
 */
export function useWarehouseLabelLayout() {
  const config = useRuntimeConfig();
  const layout = ref<LabelLayout>({});

  onMounted(async () => {
    const data = await fetchWarehouseConfig(config.public.apiBaseUrl);
    if (!data) return;
    const code = String(data.warehouseCode ?? "").toLowerCase();
    setWarehouseLabelSizes(code);
    if (code === "sz") {
      layout.value = { border: true };
    }
  });

  return { layout };
}
