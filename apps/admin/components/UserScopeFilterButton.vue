<script setup lang="ts">
import { formatScopeSummary, type SubInventoryScope } from "~/utils/userScope";

// Inline editor for the logged-in user's own sub-inventory scope, placed on
// the receiving/picking list filter bars (spec
// 2026-09-11-user-subinventory-scope-design.md). Emits "saved" after a
// successful save so the host page can refetch its (now re-scoped) list.

interface MeProfile {
  username: string;
  subInventoryScopes: SubInventoryScope[];
}

const emit = defineEmits<{
  saved: [];
}>();

const api = useApi();

const current = ref<SubInventoryScope[]>([]);
const open = ref(false);
const draft = ref<SubInventoryScope[]>([]);
const saving = ref(false);
const error = ref("");

const summary = computed(() => formatScopeSummary(current.value));

async function load() {
  try {
    const profile = await api.get<MeProfile>("/auth/me/profile");
    current.value = profile.subInventoryScopes ?? [];
  } catch {
    // Label falls back to the unrestricted text; the dialog surfaces load errors.
  }
}

function startEdit() {
  draft.value = current.value.map((s) => ({ ...s }));
  error.value = "";
  open.value = true;
}

function close() {
  open.value = false;
  error.value = "";
}

const { onMousedown, onClick } = useOverlayDismiss(close);

async function save() {
  if (saving.value) return;
  saving.value = true;
  error.value = "";
  try {
    const profile = await api.put<MeProfile>("/auth/me/profile", { subInventoryScopes: draft.value });
    current.value = profile.subInventoryScopes ?? [];
    close();
    emit("saved");
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>  <button class="btn scope-btn" :title="$t('admin.scopeFilter.buttonTitle')" @click="startEdit">
    {{ summary ? $t("admin.scopeFilter.button", { scope: summary }) : $t("admin.scopeFilter.unrestricted") }}
  </button>

  <div v-if="open" class="overlay" @mousedown="onMousedown" @click="onClick">
    <div class="dialog">
      <h2>{{ $t("admin.scopeFilter.dialogTitle") }}</h2>
      <div v-if="error" class="error-banner">{{ error }}</div>
      <SubInventoryScopePicker v-model="draft" />
      <div class="dialog-actions">
        <button class="btn" @click="close">{{ $t("admin.common.cancel") }}</button>
        <button class="btn btn-primary" :disabled="saving" @click="save">
          {{ saving ? $t("admin.common.saving") : $t("admin.common.save") }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.scope-btn {
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
