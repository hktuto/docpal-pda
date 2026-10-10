<script setup lang="ts">
import type { EntityField } from "~/utils/entities";

// Custom form for inventory labels: replaces the separate org + sub-inventory
// fields with a single dropdown. The dropdown shows org/sub-inventory pairs
// grouped by org; the value is the exact "orgId:code" pair the backend expects.

const props = defineProps<{
  title: string;
  /** All (org_id, secondary_inventory_name) pairs from org_info. */
  locationOptions: { orgId: number; secondaryInventoryName: string; subinvDescription: string | null; officeCode: string | null; label: string | null }[];
  /** Row being edited, or null for create. */
  initial: Record<string, any> | null;
  serverError?: string;
}>();

const emit = defineEmits<{
  save: [payload: { orgId: number; subInventoryCode: string; label: string; sortOrder: number; isActive: boolean; remark: string | null }];
  cancel: [];
}>();

const { t } = useI18n();

interface LocationOption {
  value: string;
  label: string;
  group: string;
}

const locationSelectOptions = computed<LocationOption[]>(() => {
  const out: LocationOption[] = [];
  for (const l of props.locationOptions) {
    const orgLabel = l.officeCode ?? String(l.orgId);
    const display = l.label ?? (l.subinvDescription ? `${orgLabel} / ${l.secondaryInventoryName} — ${l.subinvDescription}` : `${orgLabel} / ${l.secondaryInventoryName}`);
    out.push({
      value: `${l.orgId}:${l.secondaryInventoryName}`,
      label: display,
      group: orgLabel,
    });
  }
  return out;
});

const selectedLocation = ref("");
const label = ref("");
const sortOrder = ref(0);
const isActive = ref(true);
const remark = ref("");
const localError = ref("");

// Populate from initial (edit mode)
watch(
  () => props.initial,
  (val) => {
    if (val) {
      selectedLocation.value = val.orgId != null && val.subInventoryCode ? `${val.orgId}:${val.subInventoryCode}` : "";
      label.value = val.label ?? "";
      sortOrder.value = val.sortOrder ?? 0;
      isActive.value = val.isActive ?? true;
      remark.value = val.remark ?? "";
    } else {
      selectedLocation.value = "";
      label.value = "";
      sortOrder.value = 0;
      isActive.value = true;
      remark.value = "";
    }
    localError.value = "";
  },
  { immediate: true }
);

const editing = computed(() => props.initial !== null);

function submit() {
  localError.value = "";
  if (!selectedLocation.value) {
    localError.value = t("admin.common.required", { label: t("admin.fields.subInventoryCode") });
    return;
  }
  if (!label.value.trim()) {
    localError.value = t("admin.common.required", { label: t("admin.fields.label") });
    return;
  }
  const idx = selectedLocation.value.indexOf(":");
  const orgId = Number(selectedLocation.value.slice(0, idx));
  const subInventoryCode = selectedLocation.value.slice(idx + 1);
  if (!Number.isInteger(orgId) || !subInventoryCode) {
    localError.value = t("admin.common.mustBeNumber", { label: t("admin.fields.subInventoryCode") });
    return;
  }
  emit("save", {
    orgId,
    subInventoryCode,
    label: label.value.trim(),
    sortOrder: Number(sortOrder.value) || 0,
    isActive: isActive.value,
    remark: remark.value.trim() || null,
  });
}
</script>

<template>
  <div class="overlay" @mousedown.self="$emit('cancel')">
    <div class="dialog">
      <h2>{{ title }}</h2>
      <div v-if="localError || serverError" class="error-banner">{{ localError || serverError }}</div>
      <form @submit.prevent="submit">
        <div class="form-row">
          <label for="il-location">{{ $t("admin.fields.subInventoryCode") }}<span class="req"> *</span></label>
          <SearchableSelect
            id="il-location"
            v-model="selectedLocation"
            :options="locationSelectOptions"
            :all-label="$t('admin.fields.subInventoryCode')"
            :aria-label="$t('admin.fields.subInventoryCode')"
            :multiple="false"
            :show-all="false"
          />
        </div>
        <div class="form-row">
          <label for="il-label">{{ $t("admin.fields.label") }}<span class="req"> *</span></label>
          <input id="il-label" v-model="label" type="text" />
        </div>
        <div class="form-row">
          <label for="il-sort">{{ $t("admin.fields.sortOrder") }}</label>
          <input id="il-sort" v-model="sortOrder" type="number" step="any" />
        </div>
        <div class="form-row">
          <label for="il-active">{{ $t("admin.fields.isActive") }}</label>
          <input id="il-active" v-model="isActive" type="checkbox" class="bool-input" />
        </div>
        <div class="form-row">
          <label for="il-remark">{{ $t("admin.fields.remark") }}</label>
          <input id="il-remark" v-model="remark" type="text" />
        </div>
        <div class="dialog-actions">
          <button type="button" class="btn" @click="$emit('cancel')">{{ $t("admin.common.cancel") }}</button>
          <button type="submit" class="btn btn-primary">{{ $t("admin.common.save") }}</button>
        </div>
      </form>
    </div>
  </div>
</template>

<style scoped>
.dialog {
  background: #fff;
  border: 1px solid #d8e1ea;
  border-radius: 0.5rem;
  padding: 1rem 1.25rem;
  min-width: 24rem;
  max-width: 32rem;
}
.dialog h2 {
  font-size: 1rem;
  margin: 0 0 0.75rem;
}
.form-row {
  margin-bottom: 0.75rem;
}
.form-row label {
  display: block;
  font-size: 0.875rem;
  font-weight: 600;
  margin-bottom: 0.25rem;
  color: #37424e;
}
.form-row input[type="text"],
.form-row input[type="number"] {
  width: 100%;
  padding: 0.375rem 0.5rem;
  border: 1px solid #b6c2cd;
  border-radius: 0.25rem;
  font-size: 0.875rem;
}
.bool-input {
  width: auto;
}
.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 1rem;
}
.req {
  color: #dc2626;
}
.error-banner {
  background: #fef2f2;
  border: 1px solid #fecaca;
  color: #dc2626;
  padding: 0.5rem 0.75rem;
  border-radius: 0.25rem;
  font-size: 0.875rem;
  margin-bottom: 0.75rem;
}
</style>