<template>
  <select
    class="country-select"
    :value="modelValue ?? ''"
    @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value)"
  >
    <option value="">{{ placeholder }}</option>
    <option v-for="opt in options" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
  </select>
</template>

<script setup lang="ts">
// COO/COW dropdown over the country_list master (spec
// docs/superpowers/specs/2026-10-07-label-scan-review-edits-and-country-dropdown-design.md).
// Value = ISO alpha-2 code; the current value and OCR candidates that are not
// country codes stay selectable as raw extra options so a scan never gets
// silently blanked.
const props = defineProps<{
  modelValue: string | null | undefined;
  placeholder: string;
  candidates?: string[];
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: string): void;
}>();

const { countries, ensureCountries, countryLabel } = useCountryList();
onMounted(() => { void ensureCountries(); });

const options = computed(() => {
  const opts = countries.value.map((c) => ({ value: c.code, label: `${countryLabel(c)} (${c.code})` }));
  const extras = [...new Set(
    [props.modelValue, ...(props.candidates ?? [])]
      .map((v) => (v == null ? "" : String(v).trim()))
      .filter((v) => v !== "" && !opts.some((o) => o.value === v))
  )];
  return [...opts, ...extras.map((v) => ({ value: v, label: v }))];
});
</script>

<style scoped>
.country-select {
  padding: 0.5rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  color: var(--text);
  font-size: 0.9375rem;
}
</style>
