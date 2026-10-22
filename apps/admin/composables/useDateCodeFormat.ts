// Shared accessor for the flow config dateCodeFormat — the receiving
// enclave's label date-code format ("wwyy" default | "yyww"). One GET /config
// fetch per session; falls back to "wwyy" (the backend default) until the
// config arrives. Consumers compare/filter enclave-format values (receiving
// item date codes) against canonical YYWW values by canonicalizing through
// utils/dateCode.ts toCanonicalDateCode (spec
// docs/superpowers/specs/2026-10-22-datecode-format-config-design.md).
import type { DateCodeFormat } from "~/utils/dateCode";

const DEFAULT_FORMAT: DateCodeFormat = "wwyy";

const format = ref<DateCodeFormat>(DEFAULT_FORMAT);
let loading: Promise<void> | null = null;

function ensureLoaded(): Promise<void> {
  if (!loading) {
    loading = useApi()
      .get<{ dateCodeFormat?: DateCodeFormat }>("/config")
      .then((cfg) => {
        if (cfg.dateCodeFormat === "wwyy" || cfg.dateCodeFormat === "yyww") {
          format.value = cfg.dateCodeFormat;
        }
      })
      .catch(() => {
        // Keep the default; enclave values pass through unconverted.
      });
  }
  return loading;
}

export function useDateCodeFormat() {
  // Called from component setup — Nuxt context (runtime config etc.) is live.
  void ensureLoaded();
  return { format: readonly(format) };
}
