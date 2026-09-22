// Shared accessor for the date-code display template (warehouse_config row
// "flow" key dateCodeDisplayTemplate). One fetch per session — every consumer
// (receiving/picking detail pages, allocation tooltip) shares the same
// template ref and re-renders when it loads. Falls back to the backend
// default "[date_code][coo]" until the config arrives. Also fetches the
// country list once to resolve the [coo_short]/[cow_short] placeholders via
// country_list.short_code (spec 2026-09-22-coo-cow-short-code-design.md).
import { formatDateCodeDisplay, type DateCodeFields } from "~/utils/dateCodeDisplay";

const DEFAULT_TEMPLATE = "[date_code][coo]";

const template = ref(DEFAULT_TEMPLATE);
const shortCodes = ref<Record<string, string>>({});
let loading: Promise<void> | null = null;

function ensureLoaded(): Promise<void> {
  if (!loading) {
    const api = useApi();
    loading = Promise.all([
      useFlowApi()
        .getFlowConfig()
        .then((state) => {
          if (typeof state.config.dateCodeDisplayTemplate === "string" && state.config.dateCodeDisplayTemplate.trim() !== "") {
            template.value = state.config.dateCodeDisplayTemplate;
          }
        }),
      api
        .get<Array<{ code: string; shortCode: string | null }>>("/admin/countries")
        .then((rows) => {
          const map: Record<string, string> = {};
          for (const row of rows) {
            if (row.shortCode) map[row.code.toUpperCase()] = row.shortCode;
          }
          shortCodes.value = map;
        }),
    ]).catch(() => {
      // Keep the defaults; display sites render with them.
    });
  }
  return loading;
}

export function useDateCodeDisplay() {
  // Called from component setup — Nuxt context (runtime config etc.) is live.
  void ensureLoaded();
  function format(fields: DateCodeFields): string {
    return formatDateCodeDisplay(fields, template.value, shortCodes.value);
  }
  return { template: readonly(template), format };
}
