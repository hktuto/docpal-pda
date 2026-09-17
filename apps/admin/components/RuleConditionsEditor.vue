<script setup lang="ts">
export interface RuleCondition {
  field: string;
  operator: string;
  value: string;
}

export interface RuleConditions {
  combinator: "and" | "or";
  conditions: RuleCondition[];
}

// Structured editor for a label-print-rule conditions object: one AND/OR
// combinator plus a flat list of field/operator/value rows. org_id is
// exact-match only (and must be numeric — enforced by the backend); the
// other fields also allow glob `match`.
const model = defineModel<RuleConditions>({
  default: () => ({ combinator: "and", conditions: [{ field: "org_id", operator: "eq", value: "" }] }),
});
const { t } = useI18n();

const FIELDS = ["org_id", "sub_inventory", "supplier", "order_no", "order_type", "customer"] as const;

const fieldLabelKeys: Record<string, string> = {
  org_id: "admin.pages.labelPrintRules.fields.org_id",
  sub_inventory: "admin.pages.labelPrintRules.fields.sub_inventory",
  supplier: "admin.pages.labelPrintRules.fields.supplier",
  order_no: "admin.pages.labelPrintRules.fields.order_no",
  order_type: "admin.pages.labelPrintRules.fields.order_type",
  customer: "admin.pages.labelPrintRules.fields.customer",
};

function operatorsFor(field: string): string[] {
  return field === "org_id" ? ["eq"] : ["eq", "match"];
}

function setCombinator(combinator: "and" | "or") {
  model.value = { ...model.value, combinator };
}

function updateRow(index: number, patch: Partial<RuleCondition>) {
  const conditions = model.value.conditions.map((c, i) => ({ ...c, ...(i === index ? patch : {}) }));
  const row = conditions[index];
  if (!operatorsFor(row.field).includes(row.operator)) row.operator = "eq";
  model.value = { ...model.value, conditions };
}

function addRow() {
  model.value = {
    ...model.value,
    conditions: [...model.value.conditions, { field: "org_id", operator: "eq", value: "" }],
  };
}

function removeRow(index: number) {
  const conditions = model.value.conditions.filter((_, i) => i !== index);
  model.value = {
    ...model.value,
    conditions: conditions.length > 0 ? conditions : [{ field: "org_id", operator: "eq", value: "" }],
  };
}
</script>

<template>
  <div class="cond-editor">
    <div class="combinator-row">
      <button
        type="button"
        class="btn seg-btn"
        :class="{ 'seg-active': model.combinator === 'and' }"
        @click="setCombinator('and')"
      >
        {{ t("admin.pages.labelPrintRules.combinatorAnd") }}
      </button>
      <button
        type="button"
        class="btn seg-btn"
        :class="{ 'seg-active': model.combinator === 'or' }"
        @click="setCombinator('or')"
      >
        {{ t("admin.pages.labelPrintRules.combinatorOr") }}
      </button>
    </div>
    <div v-for="(row, i) in model.conditions" :key="i" class="cond-row">
      <select
        :value="row.field"
        :aria-label="t('admin.pages.labelPrintRules.conditionField')"
        @change="updateRow(i, { field: ($event.target as HTMLSelectElement).value })"
      >
        <option v-for="f in FIELDS" :key="f" :value="f">{{ t(fieldLabelKeys[f]) }}</option>
      </select>
      <select
        :value="row.operator"
        :aria-label="t('admin.pages.labelPrintRules.conditionOperator')"
        @change="updateRow(i, { operator: ($event.target as HTMLSelectElement).value })"
      >
        <option v-for="op in operatorsFor(row.field)" :key="op" :value="op">
          {{ t(`admin.pages.labelPrintRules.operators.${op}`) }}
        </option>
      </select>
      <input
        type="text"
        class="cond-value"
        :value="row.value"
        :placeholder="t('admin.pages.labelPrintRules.valuePlaceholder')"
        :aria-label="t('admin.pages.labelPrintRules.conditionValue')"
        @input="updateRow(i, { value: ($event.target as HTMLInputElement).value })"
      />
      <button type="button" class="btn btn-danger" @click="removeRow(i)">
        {{ t("admin.pages.labelPrintRules.removeCondition") }}
      </button>
    </div>
    <button type="button" class="btn" @click="addRow">
      {{ t("admin.pages.labelPrintRules.addCondition") }}
    </button>
  </div>
</template>

<style scoped>
.cond-editor {
  border: 1px solid #dde4ea;
  border-radius: 0.375rem;
  padding: 0.75rem;
}

.combinator-row {
  display: flex;
  gap: 0.25rem;
  margin-bottom: 0.75rem;
}

.seg-btn {
  border-radius: 0.25rem;
}

.seg-active {
  background: var(--brand-teal, #0e7c86);
  border-color: var(--brand-teal, #0e7c86);
  color: #fff;
}

.cond-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}

.cond-row select,
.cond-row input {
  padding: 0.4375rem 0.5625rem;
  border: 1px solid #b6c2cd;
  border-radius: 0.25rem;
  font-size: 0.875rem;
  font-family: inherit;
}

.cond-value {
  flex: 1;
  min-width: 8rem;
}
</style>
