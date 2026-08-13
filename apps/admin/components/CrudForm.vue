<script setup lang="ts">
import type { EntityField } from "~/utils/entities";

const props = defineProps<{
  title: string;
  fields: EntityField[];
  /** Row being edited, or null for create. Field values prefill the form. */
  initial: Record<string, any> | null;
  /** Server error text from the last failed save attempt. */
  serverError?: string;
}>();

const emit = defineEmits<{
  save: [payload: Record<string, unknown>];
  cancel: [];
}>();

const { t } = useI18n();
const api = useApi();
const form = reactive<Record<string, string | string[]>>({});
const localError = ref("");

// multiSelect option lists (per optionsSource). Loaded once on mount.
const subInventoryOptions = ref<{ value: string; label: string }[]>([]);

onMounted(async () => {
  if (!props.fields.some((f) => f.optionsSource === "subInventories")) return;
  try {
    const rows = await api.get<{ orgId: number; code: string }[]>("/admin/sub-inventories");
    subInventoryOptions.value = rows
      .map((r) => ({ value: r.code, label: `${r.code} (org ${r.orgId})` }))
      .sort((a, b) => a.label.localeCompare(b.label));
  } catch {
    subInventoryOptions.value = []; // options stay empty; the field can still be cleared
  }
});

function optionsFor(f: EntityField): { value: string; label: string }[] {
  return f.optionsSource === "subInventories" ? subInventoryOptions.value : [];
}

// Dismiss only on a genuine overlay click (press starts and ends on the
// overlay), so selecting text inside the dialog doesn't close it.
const { onMousedown, onClick } = useOverlayDismiss(() => emit("cancel"));

const editing = computed(() => props.initial !== null);

watch(
  () => props.initial,
  (val) => {
    for (const f of props.fields) {
      const v = val?.[f.key];
      form[f.key] =
        f.type === "multiSelect"
          ? Array.isArray(v)
            ? v.map(String)
            : []
          : v === null || v === undefined
            ? ""
            : String(v);
    }
    localError.value = "";
  },
  { immediate: true }
);

function disabled(f: EntityField): boolean {
  return editing.value && !!f.readonlyOnEdit;
}

/** Show the required marker; write-only fields are only required on create. */
function showRequired(f: EntityField): boolean {
  return !!f.required && !(editing.value && f.omitWhenEmpty);
}

function submit() {
  localError.value = "";
  const payload: Record<string, unknown> = {};
  for (const f of props.fields) {
    if (disabled(f)) continue;
    if (f.type === "multiSelect") {
      const selected = Array.isArray(form[f.key]) ? (form[f.key] as string[]) : [];
      payload[f.key] = selected.length > 0 ? selected : null; // null = clear
      continue;
    }
    const raw = String(form[f.key] ?? "").trim();
    if (raw === "") {
      // Write-only fields (e.g. password): blank means "don't send" — on edit
      // this keeps the current server-side value.
      if (f.omitWhenEmpty) {
        if (f.required && !editing.value) {
          localError.value = t("admin.common.required", { label: t(f.label) });
          return;
        }
        continue;
      }
      if (f.required) {
        localError.value = t("admin.common.required", { label: t(f.label) });
        return;
      }
      payload[f.key] = null; // server treats null as "clear this optional field"
      continue;
    }
    if (f.type === "number") {
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        localError.value = t("admin.common.mustBeNumber", { label: t(f.label) });
        return;
      }
      payload[f.key] = n;
    } else {
      payload[f.key] = raw;
    }
  }
  emit("save", payload);
}
</script>

<template>
  <div class="overlay" @mousedown="onMousedown" @click="onClick">
    <div class="dialog">
      <h2>{{ title }}</h2>
      <div v-if="localError || serverError" class="error-banner">{{ localError || serverError }}</div>
      <form @submit.prevent="submit">
        <div v-for="f in fields" :key="f.key" class="form-row">
          <label :for="`ff-${f.key}`">
            {{ $t(f.label) }}<span v-if="showRequired(f)" class="req"> *</span>
          </label>
          <select
            v-if="f.type === 'multiSelect'"
            :id="`ff-${f.key}`"
            v-model="form[f.key]"
            multiple
            :disabled="disabled(f)"
            class="multi-select"
          >
            <option v-for="o in optionsFor(f)" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
          <input
            v-else
            :id="`ff-${f.key}`"
            v-model="form[f.key]"
            :type="f.type === 'number' ? 'number' : f.type === 'password' ? 'password' : 'text'"
            :step="f.type === 'number' ? 'any' : undefined"
            :disabled="disabled(f)"
          />
        </div>
        <div class="dialog-actions">
          <button type="button" class="btn" @click="emit('cancel')">{{ $t("admin.common.cancel") }}</button>
          <button type="submit" class="btn btn-primary">{{ $t("admin.common.save") }}</button>
        </div>
      </form>
    </div>
  </div>
</template>

<style scoped>
.multi-select {
  min-height: 5rem;
  width: 100%;
}
</style>
