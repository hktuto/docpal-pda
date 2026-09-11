<script setup lang="ts">
import type { SubInventoryScope } from "~/utils/userScope";

// Org-grouped checkbox picker for per-user sub-inventory scopes
// (spec 2026-09-11-user-subinventory-scope-design.md). Empty selection =
// unrestricted. Shared by pages/user-profiles.vue and pages/settings.vue.

interface SubInventoryRow {
  orgId: number;
  secondaryInventoryName: string;
  subinvDescription: string | null;
  officeCode: string | null;
}

const props = defineProps<{
  modelValue: SubInventoryScope[];
}>();

const emit = defineEmits<{
  "update:modelValue": [value: SubInventoryScope[]];
}>();

const api = useApi();

const rows = ref<SubInventoryRow[]>([]);
const loading = ref(true);
const loadError = ref("");

const groups = computed(() => {
  const byOrg = new Map<number, SubInventoryRow[]>();
  for (const r of rows.value) {
    const list = byOrg.get(r.orgId) ?? [];
    list.push(r);
    byOrg.set(r.orgId, list);
  }
  return [...byOrg.entries()]
    .sort(([a], [b]) => a - b)
    .map(([orgId, items]) => ({
      orgId,
      office: items[0]?.officeCode ?? null,
      items: items.sort((a, b) => a.secondaryInventoryName.localeCompare(b.secondaryInventoryName)),
    }));
});

function keyOf(orgId: number, code: string): string {
  return `${orgId}::${code}`;
}

const selectedKeys = computed(() => new Set(props.modelValue.map((s) => keyOf(s.orgId, s.code))));

function isChecked(row: SubInventoryRow): boolean {
  return selectedKeys.value.has(keyOf(row.orgId, row.secondaryInventoryName));
}

function toggle(row: SubInventoryRow) {
  const key = keyOf(row.orgId, row.secondaryInventoryName);
  if (selectedKeys.value.has(key)) {
    emit(
      "update:modelValue",
      props.modelValue.filter((s) => keyOf(s.orgId, s.code) !== key)
    );
  } else {
    emit("update:modelValue", [...props.modelValue, { orgId: row.orgId, code: row.secondaryInventoryName }]);
  }
}

function label(row: SubInventoryRow): string {
  return row.subinvDescription
    ? `${row.secondaryInventoryName} — ${row.subinvDescription}`
    : row.secondaryInventoryName;
}

function selectAll() {
  emit(
    "update:modelValue",
    rows.value.map((r) => ({ orgId: r.orgId, code: r.secondaryInventoryName }))
  );
}

function clearAll() {
  emit("update:modelValue", []);
}

interface OrgGroup {
  orgId: number;
  office: string | null;
  items: SubInventoryRow[];
}

function isGroupChecked(g: OrgGroup): boolean {
  return g.items.length > 0 && g.items.every((r) => isChecked(r));
}

function toggleGroup(g: OrgGroup) {
  if (isGroupChecked(g)) {
    const keys = new Set(g.items.map((r) => keyOf(r.orgId, r.secondaryInventoryName)));
    emit(
      "update:modelValue",
      props.modelValue.filter((s) => !keys.has(keyOf(s.orgId, s.code)))
    );
  } else {
    const missing = g.items
      .filter((r) => !isChecked(r))
      .map((r) => ({ orgId: r.orgId, code: r.secondaryInventoryName }));
    emit("update:modelValue", [...props.modelValue, ...missing]);
  }
}

onMounted(async () => {
  loading.value = true;
  loadError.value = "";
  try {
    // Options are limited to the flow config's allowedOrgIds ([] = all orgs).
    const [invRows, cfg] = await Promise.all([
      api.get<SubInventoryRow[]>("/admin/sub-inventories"),
      api.get<{ allowedOrgIds: number[] }>("/config"),
    ]);
    const allowed = cfg.allowedOrgIds ?? [];
    rows.value = allowed.length ? invRows.filter((r) => allowed.includes(r.orgId)) : invRows;
  } catch (e: any) {
    loadError.value = e?.message ?? String(e);
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="scope-picker">
    <p class="hint">{{ $t("admin.scopePicker.hint") }}</p>
    <div v-if="loading" class="loading">{{ $t("admin.scopePicker.loading") }}</div>
    <div v-else-if="loadError" class="error-banner">
      {{ $t("admin.scopePicker.loadError", { message: loadError }) }}
    </div>
    <div v-else-if="groups.length === 0" class="muted">{{ $t("admin.scopePicker.none") }}</div>
    <template v-else>
      <div class="picker-toolbar">
        <button type="button" class="btn btn-small" @click="selectAll">
          {{ $t("admin.scopePicker.selectAll") }}
        </button>
        <button type="button" class="btn btn-small" :disabled="modelValue.length === 0" @click="clearAll">
          {{ $t("admin.scopePicker.clearAll") }}
        </button>
      </div>
      <div class="scope-groups">
        <div v-for="g in groups" :key="g.orgId" class="scope-group">
          <label class="scope-org scope-group-toggle">
            <input type="checkbox" :checked="isGroupChecked(g)" @change="toggleGroup(g)" />
            <span>{{ g.office ?? $t("admin.scopePicker.orgFallback", { orgId: g.orgId }) }}</span>
          </label>
          <label v-for="r in g.items" :key="r.secondaryInventoryName" class="scope-option">
            <input type="checkbox" :checked="isChecked(r)" @change="toggle(r)" />
            <span>{{ label(r) }}</span>
          </label>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.scope-picker .hint {
  margin: 0 0 10px;
  font-size: 13px;
  color: #64748b;
}

.picker-toolbar {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
}

.scope-groups {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-height: 320px;
  overflow-y: auto;
  border: 1px solid #d8e1ea;
  border-radius: 8px;
  padding: 10px 12px;
}

.scope-org {
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #64748b;
  margin-bottom: 4px;
}

.scope-group-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}

.scope-option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 0;
  font-size: 14px;
  cursor: pointer;
}
</style>
