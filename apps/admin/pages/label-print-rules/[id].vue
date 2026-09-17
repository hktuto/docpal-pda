<script setup lang="ts">
import type { RuleConditions } from "~/components/RuleConditionsEditor.vue";

// Label print rule edit page: left = edit form (PATCH), right = match preview
// that tests the CURRENT DRAFT conditions against picking orders. No
// auto-refresh — the preview only queries when the Test button is clicked.
const route = useRoute();
const api = useApi();
const { t } = useI18n();

const ruleId = route.params.id as string;

const rule = ref<any | null>(null);
const error = ref("");
const loading = ref(true);

const form = reactive({
  name: "",
  labelType: "",
  conditions: { combinator: "and", conditions: [{ field: "org_id", operator: "eq", value: "" }] } as RuleConditions,
  printTemplateId: "",
  priority: "",
  active: true,
  remark: "",
});

const saving = ref(false);
const saved = ref(false);
let savedTimer: ReturnType<typeof setTimeout> | undefined;

const labelTypeOptions = computed(() =>
  ["carton", "item_box", "item"].map((value) => ({
    value,
    label: t(`admin.pages.labelPrintRules.labelTypes.${value}`),
  }))
);

async function load() {
  loading.value = true;
  error.value = "";
  try {
    rule.value = await api.get(`/admin/label-print-rules/${ruleId}`);
    form.name = rule.value.name ?? "";
    form.labelType = rule.value.labelType ?? "";
    form.conditions = JSON.parse(JSON.stringify(rule.value.conditions));
    form.printTemplateId = rule.value.printTemplateId ?? "";
    form.priority = rule.value.priority != null ? String(rule.value.priority) : "";
    form.active = !!rule.value.active;
    form.remark = rule.value.remark ?? "";
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

onMounted(load);

/** Mirrors CrudForm submit(): ≥1 row, non-empty trimmed values, numeric org_id. */
function draftConditions(): RuleConditions | null {
  const c = form.conditions;
  const rows = (c?.conditions ?? []).map((r) => ({
    field: r.field,
    operator: r.operator,
    value: String(r.value ?? "").trim(),
  }));
  const valid =
    (c?.combinator === "and" || c?.combinator === "or") &&
    rows.length > 0 &&
    rows.every((r) => r.value !== "" && (r.field !== "org_id" || /^\d+$/.test(r.value)));
  return valid ? { combinator: c.combinator, conditions: rows } : null;
}

async function save() {
  saved.value = false;
  error.value = "";
  const conditions = draftConditions();
  if (!conditions) {
    error.value = t("admin.pages.labelPrintRules.conditionsInvalid");
    return;
  }
  if (!form.name.trim() || !form.labelType || !form.printTemplateId.trim()) {
    error.value = t("admin.pages.labelPrintRules.requiredFields");
    return;
  }
  const priorityRaw = form.priority.trim();
  const priority = priorityRaw === "" ? undefined : Number(priorityRaw);
  if (priority !== undefined && !Number.isFinite(priority)) {
    error.value = t("admin.common.mustBeNumber", { label: t("admin.fields.priority") });
    return;
  }
  saving.value = true;
  try {
    await api.patch(`/admin/label-print-rules/${ruleId}`, {
      name: form.name.trim(),
      labelType: form.labelType,
      conditions,
      printTemplateId: form.printTemplateId.trim(),
      // NOT NULL column — a blank field keeps the server value instead of sending null.
      ...(priority !== undefined && { priority }),
      active: form.active,
      remark: form.remark.trim() === "" ? null : form.remark.trim(),
    });
    await load();
    saved.value = true;
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => {
      saved.value = false;
    }, 5000);
  } catch (e: any) {
    error.value = e.message;
  } finally {
    saving.value = false;
  }
}

// ---- match preview ----
const keyword = ref("");
const testing = ref(false);
const previewError = ref("");
const previewRows = ref<any[] | null>(null); // null = not searched yet
const previewTotal = ref(0);
const PREVIEW_LIMIT = 50;

const canTest = computed(() => !testing.value && draftConditions() !== null);

async function testMatch() {
  previewError.value = "";
  const conditions = draftConditions();
  if (!conditions) {
    previewError.value = t("admin.pages.labelPrintRules.conditionsInvalid");
    return;
  }
  testing.value = true;
  try {
    const res = await api.post<{ rows: any[]; total: number }>("/admin/label-print-rules/test-match", {
      conditions,
      keyword: keyword.value.trim() || undefined,
      limit: PREVIEW_LIMIT,
    });
    previewRows.value = res.rows;
    previewTotal.value = res.total;
  } catch (e: any) {
    previewRows.value = null;
    previewError.value = e.message;
  } finally {
    testing.value = false;
  }
}
</script>

<template>
  <div>
    <div class="page-head">
      <h1>{{ $t("admin.pages.labelPrintRules.editTitle", { name: rule?.name ?? "" }) }}</h1>
      <NuxtLink to="/label-print-rules" class="btn">{{ $t("admin.common.back") }}</NuxtLink>
    </div>
    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-if="loading" class="loading">{{ $t("admin.common.loading") }}</div>
    <div v-else-if="rule" class="edit-preview-grid">
      <section class="panel">
        <form @submit.prevent="save">
          <div class="form-row">
            <label for="lpr-name">{{ $t("admin.fields.name") }}<span class="req"> *</span></label>
            <input id="lpr-name" v-model="form.name" type="text" />
          </div>
          <div class="form-row">
            <label>{{ $t("admin.fields.labelType") }}<span class="req"> *</span></label>
            <SearchableSelect
              v-model="form.labelType"
              :options="labelTypeOptions"
              :all-label="$t('admin.fields.labelType')"
              :aria-label="$t('admin.fields.labelType')"
              :multiple="false"
              :show-all="false"
            />
          </div>
          <div class="form-row">
            <label>{{ $t("admin.fields.conditions") }}<span class="req"> *</span></label>
            <RuleConditionsEditor v-model="form.conditions" />
          </div>
          <div class="form-row">
            <label for="lpr-template">{{ $t("admin.fields.printTemplateId") }}<span class="req"> *</span></label>
            <input id="lpr-template" v-model="form.printTemplateId" type="text" />
            <p class="hint">{{ $t("admin.fields.printTemplateIdHint") }}</p>
          </div>
          <div class="form-row">
            <label for="lpr-priority">{{ $t("admin.fields.priority") }}</label>
            <input id="lpr-priority" v-model="form.priority" type="number" step="any" />
          </div>
          <div class="form-row">
            <label for="lpr-active">{{ $t("admin.fields.active") }}</label>
            <input id="lpr-active" v-model="form.active" type="checkbox" class="bool-input" />
          </div>
          <div class="form-row">
            <label for="lpr-remark">{{ $t("admin.fields.remark") }}</label>
            <input id="lpr-remark" v-model="form.remark" type="text" />
          </div>
          <div class="panel-actions">
            <span v-if="saved" class="muted">{{ $t("admin.common.saved") }}</span>
            <button type="submit" class="btn btn-primary" :disabled="saving">
              {{ saving ? $t("admin.common.saving") : $t("admin.common.save") }}
            </button>
          </div>
        </form>
      </section>

      <section class="panel">
        <h2 class="panel-title">{{ $t("admin.pages.labelPrintRules.previewTitle") }}</h2>
        <p class="hint">{{ $t("admin.pages.labelPrintRules.previewNote") }}</p>
        <div class="preview-controls">
          <input
            v-model="keyword"
            type="text"
            :placeholder="$t('admin.pages.labelPrintRules.keywordPlaceholder')"
            @keyup.enter="canTest && testMatch()"
          />
          <button class="btn btn-primary" :disabled="!canTest" @click="testMatch">
            {{ testing ? $t("admin.pages.labelPrintRules.testing") : $t("admin.pages.labelPrintRules.testMatch") }}
          </button>
        </div>
        <div v-if="previewError" class="error-banner">{{ previewError }}</div>
        <template v-else-if="previewRows">
          <p class="muted preview-summary">
            {{ $t("admin.pages.labelPrintRules.matchedCount", { total: previewTotal }) }}
            <template v-if="previewRows.length < previewTotal">
              — {{ $t("admin.pages.labelPrintRules.cappedNotice", { shown: previewRows.length, total: previewTotal }) }}
            </template>
          </p>
          <p v-if="previewRows.length === 0" class="muted">{{ $t("admin.pages.labelPrintRules.emptyPreview") }}</p>
          <div v-else class="table-wrap">
            <table class="data">
              <thead>
                <tr>
                  <th>{{ $t("admin.pages.labelPrintRules.colOrderNo") }}</th>
                  <th>{{ $t("admin.pages.labelPrintRules.colPoNo") }}</th>
                  <th>{{ $t("admin.pages.labelPrintRules.colCustomer") }}</th>
                  <th>{{ $t("admin.pages.labelPrintRules.colLocation") }}</th>
                  <th>{{ $t("admin.pages.labelPrintRules.colType") }}</th>
                  <th>{{ $t("admin.pages.labelPrintRules.colStatus") }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in previewRows" :key="row.id">
                  <td>{{ row.orderNo }}</td>
                  <td>{{ row.poNo ?? "—" }}</td>
                  <td>{{ row.customerCode ?? "—" }}</td>
                  <td>{{ row.orgId }} / {{ row.subInventoryCode ?? "—" }}</td>
                  <td>{{ row.pickingOrderType ?? "—" }}</td>
                  <td>{{ row.status }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </section>
    </div>
  </div>
</template>

<style scoped>
.edit-preview-grid {
  display: grid;
  grid-template-columns: minmax(37.5rem, 2fr) minmax(0, 1fr);
  gap: 1rem;
  align-items: start;
}
.panel {
  background: #fff;
  border: 1px solid #dde3e9;
  border-radius: 0.375rem;
  padding: 0.875rem 1.125rem;
}
.panel-title {
  font-size: 0.9375rem;
  margin: 0 0 0.375rem;
}
.panel-actions {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  justify-content: flex-end;
  margin-top: 0.75rem;
}
.preview-controls {
  display: flex;
  gap: 0.5rem;
  margin: 0.625rem 0;
}
.preview-controls input {
  flex: 1;
}
.preview-summary {
  font-size: 0.8125rem;
}
.bool-input {
  width: auto;
}
</style>
