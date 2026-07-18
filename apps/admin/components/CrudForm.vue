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

const form = reactive<Record<string, string>>({});
const localError = ref("");

// Dismiss only on a genuine overlay click (press starts and ends on the
// overlay), so selecting text inside the dialog doesn't close it.
const { onMousedown, onClick } = useOverlayDismiss(() => emit("cancel"));

const editing = computed(() => props.initial !== null);

watch(
  () => props.initial,
  (val) => {
    for (const f of props.fields) {
      const v = val?.[f.key];
      form[f.key] = v === null || v === undefined ? "" : String(v);
    }
    localError.value = "";
  },
  { immediate: true }
);

function disabled(f: EntityField): boolean {
  return editing.value && !!f.readonlyOnEdit;
}

function submit() {
  localError.value = "";
  const payload: Record<string, unknown> = {};
  for (const f of props.fields) {
    if (disabled(f)) continue;
    const raw = String(form[f.key] ?? "").trim();
    if (raw === "") {
      if (f.required) {
        localError.value = `${f.label} is required`;
        return;
      }
      payload[f.key] = null; // server treats null as "clear this optional field"
      continue;
    }
    if (f.type === "number") {
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        localError.value = `${f.label} must be a number`;
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
            {{ f.label }}<span v-if="f.required" class="req"> *</span>
          </label>
          <input
            :id="`ff-${f.key}`"
            v-model="form[f.key]"
            :type="f.type === 'number' ? 'number' : 'text'"
            :step="f.type === 'number' ? 'any' : undefined"
            :disabled="disabled(f)"
          />
        </div>
        <div class="dialog-actions">
          <button type="button" class="btn" @click="emit('cancel')">Cancel</button>
          <button type="submit" class="btn btn-primary">Save</button>
        </div>
      </form>
    </div>
  </div>
</template>
