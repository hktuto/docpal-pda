<script setup lang="ts">
import type { SubInventoryScope } from "~/utils/userScope";

// Batch-edit the sub-inventory affinity of the selected shelves: the chosen
// (org, code) pairs REPLACE every selected shelf's subInventoryScopes (empty =
// shared). Opened from the shelves page bulk-actions bar.

interface ShelfRow {
  code: string;
  subInventoryScopes?: SubInventoryScope[] | null;
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

const saving = ref(false);
const saveError = ref("");

async function save() {
  saving.value = true;
  saveError.value = "";
  const payload = { subInventoryScopes: scopes.value.length > 0 ? scopes.value : null };
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
  margin: 0 0 10px;
  font-size: 13px;
  color: #64748b;
}
</style>
