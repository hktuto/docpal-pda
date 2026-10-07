// Country list for the COO/COW dropdowns (spec
// docs/superpowers/specs/2026-10-07-label-scan-review-edits-and-country-dropdown-design.md):
// module-level shared cache of the country_list rows (GET /admin/countries via
// the service adapter), fetched lazily on first use. Display names translate
// client-side through the countryLabels locale map (keyed by the English
// name), falling back to the raw table name.
import type { CountryRow } from "~/services/types";

const countries = ref<CountryRow[]>([]);
let loadPromise: Promise<void> | null = null;

export function useCountryList() {
  const warehouse = useWarehouse();
  const { t } = useI18n();

  /** Fetch the country list once; concurrent callers share the request. */
  function ensureCountries(): Promise<void> {
    if (countries.value.length > 0) return Promise.resolve();
    loadPromise ??= warehouse
      .getCountries()
      .then((rows) => {
        countries.value = rows;
      })
      .catch(() => {
        loadPromise = null; // allow a retry on the next mount
      });
    return loadPromise;
  }

  /** Localized display name for a country row (fallback: the table name). */
  function countryLabel(row: CountryRow): string {
    const labels = t("countryLabels") as unknown as Record<string, string>;
    return labels[row.name] ?? row.name;
  }

  return { countries: readonly(countries), ensureCountries, countryLabel };
}
