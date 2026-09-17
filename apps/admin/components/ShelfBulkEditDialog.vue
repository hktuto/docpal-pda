<script setup lang="ts">
import type { SubInventoryScope } from "~/utils/userScope";

// Batch-edit the selected shelves: the chosen (org, code) pairs REPLACE every
// selected shelf's subInventoryScopes (empty = shared), and — only when the
// warning toggle is on — the warning text REPLACES every selected shelf's
// warning (empty = cleared). Opened from the shelves page bulk-actions bar.

interface ShelfRow {
  code: string;
  subInventoryScopes?: SubInventoryScope[] | null;
  warning?: string | null;
}

const props = defineProps<{
  shelves: ShelfRow[];
}>();

const emit = defineEmits<{
  saved: [];
  close: [];
}>();

const api = useApi();
const { onMousedown, onClick } = useOverlayDismiss(() => emit("close"));

function keyOf(s: SubInventoryScope): string {
  return `${s.orgId}::${s.code}`;
}

// Prefill with the pairs common to every selected shelf, so pairs already
// shared by all rows survive unless the user unchecks them.
const scopes = ref<SubInventoryScope[]>(
  props.shelves.reduce<SubInventoryScope[]>(
    (acc, s) => {
      const cur = new Set((s.subInventoryScopes ?? []).map(keyOf));
      return acc.filter((p) => cur.has(keyOf(p)));
    },
    props.shelves[0]?.subInventoryScopes ?? []
  )
);

// Warning: untouched unless the toggle is on. Prefill only when every
// selected shelf already carries the same warning.
const warnings = props.shelves.map((s) => s.warning ?? null);
const commonWarning = warnings.every((w) => w === warnings[0]) ? warnings[0] : undefined;
const changeWarning = ref(commonWarning != null);
const warningText = ref(commonWarning ?? "");
const warningMixed = commonWarning === undefined;

const saving = ref(false);
const saveError = ref("");

async function save() {
  saving.value = true;
  saveError.value = "";
  const payload = {
    subInventoryScopes: scopes.value.length > 0 ? scopes.value : null,
    ...(changeWarning.value ? { warning: warningText.value.trim() || null } : {}),
  };
  try {
    await Promise.all(props.shelves.map((s) => api.patch(`/admin/shelves/${s.code}`, payload)));
    emit("saved");
    emit("close");
  } catch (e: any) {
    saveError.value = e?.message ?? String(e);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="overlay" @mousedown="onMousedown" @click="onClick">
    <div class="dialog">
      <h2>{{ $t("admin.shelves.bulkEditTitle", { count: shelves.length }) }}</h2>
      <div v-if="saveError" class="error-banner">{{ saveError }}</div>

      <p class="hint">{{ $t("admin.shelves.bulkEditHint", { count: shelves.length }) }}</p>
      <SubInventoryScopePicker v-model="scopes" :disabled="saving" hint-key="admin.fields.subInventoryCodesHint" />

      <div class="warning-section">
        <label class="warning-toggle">
          <input v-model="changeWarning" type="checkbox" :disabled="saving" />
          {{ $t("admin.shelves.bulkEditWarningToggle") }}
        </label>
        <template v-if="changeWarning">
          <input
            v-model="warningText"
            type="text"
            class="warning-input"
            :disabled="saving"
            :placeholder="warningMixed ? $t('admin.shelves.bulkEditWarningMixed') : $t('admin.fields.shelfWarning')"
          />
          <p class="hint">{{ $t("admin.shelves.bulkEditWarningHint", { count: shelves.length }) }}</p>
        </template>
      </div>

      <div class="dialog-actions">
        <button type="button" class="btn" :disabled="saving" @click="emit('close')">
          {{ $t("admin.common.cancel") }}
        </button>
        <button type="button" class="btn btn-primary" :disabled="saving" @click="save">
          {{ $t("admin.common.save") }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.hint {
  margin: 0 0 0.625rem;
  font-size: 0.8125rem;
  color: #64748b;
}
.warning-section {
  margin-top: 0.75rem;
  padding-top: 0.75rem;
  border-top: 1px solid #e2e8f0;
}
.warning-toggle {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  font-size: 0.875rem;
  margin-bottom: 0.5rem;
}
.warning-input {
  width: 100%;
  box-sizing: border-box;
  margin-bottom: 0.375rem;
}
</style>
