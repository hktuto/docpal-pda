import type { Ref } from "vue";

export interface UrlQueryField<T = any> {
  state: Ref<T>;
  /** When the serialized value equals the serialized default, the param is omitted. */
  defaultValue: T;
  parse?: (raw: string) => T;
  serialize?: (value: T) => string;
}

/** Parse a positive integer query param, falling back when absent/malformed. */
export function parsePositiveInt(fallback: number) {
  return (raw: string): number => {
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
}

/**
 * Two-way sync between reactive state and URL query params, so list-page
 * filter/keyword/pagination survives navigation (browser back from a detail
 * page restores the list as it was). Writes use `router.replace` — no history
 * entries per keystroke. Values are restored from the query on setup; call
 * the returned `restore()` after the first data load for state the table
 * resets when rows arrive (autoResetPageIndex wipes a restored page).
 */
export function useUrlQueryState(fields: Record<string, UrlQueryField>) {
  const route = useRoute();
  const router = useRouter();

  function serializeField(field: UrlQueryField, value: any): string {
    return field.serialize ? field.serialize(value) : String(value);
  }

  function readQuery(): Record<string, any> {
    const values: Record<string, any> = {};
    for (const [key, field] of Object.entries(fields)) {
      const raw = route.query[key];
      const str = Array.isArray(raw) ? raw[0] : raw;
      if (typeof str !== "string" || str === "") continue;
      try {
        values[key] = field.parse ? field.parse(str) : str;
      } catch {
        // Malformed param — keep the current value.
      }
    }
    return values;
  }

  // Captured at setup: restore() re-applies these (route.query may no longer
  // hold them if a table reset briefly wrote the defaults back to the URL).
  const initialValues = readQuery();
  for (const [key, value] of Object.entries(initialValues)) {
    fields[key]!.state.value = value;
  }

  function restore() {
    for (const [key, value] of Object.entries(initialValues)) {
      fields[key]!.state.value = value;
    }
  }

  watch(
    () => Object.entries(fields).map(([, f]) => f.state.value),
    () => {
      const query = { ...route.query };
      for (const [key, field] of Object.entries(fields)) {
        const serialized = serializeField(field, field.state.value);
        if (serialized === serializeField(field, field.defaultValue)) {
          delete query[key];
        } else {
          query[key] = serialized;
        }
      }
      router.replace({ query });
    },
    { deep: true }
  );

  return { restore };
}
