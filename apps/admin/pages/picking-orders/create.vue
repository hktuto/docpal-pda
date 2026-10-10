<script setup lang="ts">
import type { SearchableSelectOption } from "~/components/SearchableSelect.vue";
import type { SubInventoryRow, TestPickingOrderCreate, TestPickingOrderTemplate } from "~/utils/flowApi";

const flow = useFlowApi();
const { t } = useI18n();
const router = useRouter();

// ---- Order header form state ----
const orderNo = ref("");
const customerCode = ref("");
const orgId = ref<number | null>(null);
const subInventoryCode = ref("");
const shipTo = ref("");
const poNo = ref("");
const deliveryDate = ref("");
const pickingOrderType = ref("");
const prioritySeq = ref(0);
const remark = ref("");

// ---- Items ----
interface ItemRow {
  partNo: string;
  qty: number | null;
  lineNumber: number | null;
}
const items = ref<ItemRow[]>([{ partNo: "", qty: null, lineNumber: 1 }]);

function addItem() {
  items.value.push({ partNo: "", qty: null, lineNumber: items.value.length + 1 });
}
function removeItem(index: number) {
  items.value.splice(index, 1);
  // Re-number remaining items
  items.value.forEach((item, i) => {
    if (item.lineNumber === null) item.lineNumber = i + 1;
  });
}

// ---- Sub-inventory options (org → sub-inventory pairing) ----
const subInventories = ref<SubInventoryRow[]>([]);

const orgOptions = computed<SearchableSelectOption[]>(() => {
  const seen = new Set<number>();
  for (const r of subInventories.value) seen.add(r.orgId);
  return [...seen].sort((a, b) => a - b).map((o) => ({ value: String(o), label: String(o) }));
});

const subInventoryOptions = computed<SearchableSelectOption[]>(() => {
  if (orgId.value === null) return [];
  return subInventories.value
    .filter((r) => r.orgId === orgId.value)
    .map((r) => ({
      value: r.secondaryInventoryName,
      label: r.subinvDescription ? `${r.secondaryInventoryName} — ${r.subinvDescription}` : r.secondaryInventoryName,
    }));
});

watch(orgId, () => {
  // Reset sub-inventory when org changes
  if (subInventoryCode.value && !subInventoryOptions.value.some((o) => o.value === subInventoryCode.value)) {
    subInventoryCode.value = "";
  }
});

// ---- Parts search ----
const partSearchQuery = ref("");
const partSearchOptions = ref<SearchableSelectOption[]>([]);
let partSearchTimer: ReturnType<typeof setTimeout> | null = null;

function searchParts(query: string) {
  if (partSearchTimer) clearTimeout(partSearchTimer);
  partSearchTimer = setTimeout(async () => {
    if (!query.trim()) {
      partSearchOptions.value = [];
      return;
    }
    try {
      const res = await flow.stockSearchPage({ partNo: query, page: 1, pageSize: 20 });
      partSearchOptions.value = res.rows.map((lot) => ({
        value: lot.partNo,
        label: lot.wclItemNo ? `${lot.partNo} (${lot.wclItemNo})` : lot.partNo,
      }));
    } catch {
      partSearchOptions.value = [];
    }
  }, 200);
}

// ---- Form validation ----
const formError = ref("");

function validate(): string {
  if (!orderNo.value.trim()) return t("admin.pages.createTestOrder.errors.orderNoRequired");
  if (orgId.value === null) return t("admin.pages.createTestOrder.errors.orgRequired");
  if (!subInventoryCode.value) return t("admin.pages.createTestOrder.errors.subInventoryRequired");
  if (items.value.length === 0) return t("admin.pages.createTestOrder.errors.atLeastOneItem");
  for (const [i, item] of items.value.entries()) {
    if (!item.partNo.trim()) return t("admin.pages.createTestOrder.errors.partNoRequired", { index: i + 1 });
    if (item.qty === null || item.qty <= 0) return t("admin.pages.createTestOrder.errors.qtyRequired", { index: i + 1 });
  }
  return "";
}

// ---- Create ----
const creating = ref(false);

async function createOrder() {
  formError.value = validate();
  if (formError.value) return;

  creating.value = true;
  try {
    const body: TestPickingOrderCreate = {
      orderNo: orderNo.value.trim(),
      customerCode: customerCode.value.trim() || undefined,
      orgId: orgId.value!,
      subInventoryCode: subInventoryCode.value,
      shipTo: shipTo.value.trim() || undefined,
      poNo: poNo.value.trim() || undefined,
      deliveryDate: deliveryDate.value || undefined,
      prioritySeq: prioritySeq.value,
      pickingOrderType: pickingOrderType.value || undefined,
      remark: remark.value.trim() || undefined,
      items: items.value.map((item, i) => ({
        partNo: item.partNo.trim(),
        qty: item.qty!,
        lineNumber: item.lineNumber ?? i + 1,
      })),
    };

    const result = await flow.createTestPickingOrder(body);
    router.push(`/picking-orders/${result.id}`);
  } catch (err: any) {
    formError.value = err?.message ?? t("admin.pages.createTestOrder.errors.createFailed");
  } finally {
    creating.value = false;
  }
}

// ---- Export JSON ----
function exportJson() {
  const template: TestPickingOrderTemplate = {
    orderNo: orderNo.value.trim(),
    customerCode: customerCode.value.trim() || null,
    orgId: orgId.value!,
    subInventoryCode: subInventoryCode.value,
    shipTo: shipTo.value.trim() || null,
    poNo: poNo.value.trim() || null,
    deliveryDate: deliveryDate.value || null,
    prioritySeq: prioritySeq.value,
    pickingOrderType: pickingOrderType.value || null,
    remark: remark.value.trim() || null,
    items: items.value.map((item, i) => ({
      partNo: item.partNo.trim(),
      qty: item.qty ?? 0,
      lineNumber: item.lineNumber ?? i + 1,
    })),
  };
  const blob = new Blob([JSON.stringify(template, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${template.orderNo || "test-picking-order"}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ---- Import JSON ----
const fileInput = ref<HTMLInputElement | null>(null);
const importError = ref("");

function triggerImport() {
  fileInput.value?.click();
}

async function importJson(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  importError.value = "";
  try {
    const text = await file.text();
    const template = JSON.parse(text) as TestPickingOrderTemplate;

    // Validate required fields
    if (!template.orderNo) throw new Error("orderNo is required in the template");
    if (!template.orgId) throw new Error("orgId is required in the template");
    if (!template.subInventoryCode) throw new Error("subInventoryCode is required in the template");
    if (!Array.isArray(template.items) || template.items.length === 0)
      throw new Error("items must be a non-empty array");

    // Fill the form
    orderNo.value = template.orderNo;
    customerCode.value = template.customerCode ?? "";
    orgId.value = template.orgId;
    subInventoryCode.value = template.subInventoryCode;
    shipTo.value = template.shipTo ?? "";
    poNo.value = template.poNo ?? "";
    deliveryDate.value = template.deliveryDate ?? "";
    pickingOrderType.value = template.pickingOrderType ?? "";
    prioritySeq.value = template.prioritySeq ?? 0;
    remark.value = template.remark ?? "";
    items.value = template.items.map((item, i) => ({
      partNo: item.partNo,
      qty: item.qty,
      lineNumber: item.lineNumber ?? i + 1,
    }));

    // Ensure sub-inventory options are loaded for the org
    if (subInventories.value.length === 0) {
      subInventories.value = await flow.listSubInventories();
    }
  } catch (err: any) {
    importError.value = err?.message ?? "Failed to parse template JSON";
  } finally {
    input.value = "";
  }
}

// ---- Load sub-inventories on mount ----
onMounted(async () => {
  subInventories.value = await flow.listSubInventories();
});
</script>

<template>
  <div class="page-container">
    <div class="page-header">
      <h1>{{ t("admin.pages.createTestOrder.title") }}</h1>
      <p class="page-description">{{ t("admin.pages.createTestOrder.description") }}</p>
    </div>

    <!-- Import / Export bar -->
    <div class="action-bar">
      <button class="btn btn-secondary" @click="triggerImport">
        {{ t("admin.pages.createTestOrder.importJson") }}
      </button>
      <button class="btn btn-secondary" @click="exportJson">
        {{ t("admin.pages.createTestOrder.exportJson") }}
      </button>
      <input
        ref="fileInput"
        type="file"
        accept=".json,application/json"
        style="display: none"
        @change="importJson"
      />
    </div>

    <div v-if="importError" class="alert alert-error">{{ importError }}</div>

    <!-- Order header -->
    <section class="form-section">
      <h2>{{ t("admin.pages.createTestOrder.orderInfo") }}</h2>
      <div class="form-grid">
        <div class="form-field">
          <label>{{ t("admin.pages.createTestOrder.orderNo") }} *</label>
          <input v-model="orderNo" type="text" placeholder="TEST-001" />
        </div>
        <div class="form-field">
          <label>{{ t("admin.pages.createTestOrder.customerCode") }}</label>
          <input v-model="customerCode" type="text" />
        </div>
        <div class="form-field">
          <label>{{ t("admin.pages.createTestOrder.orgId") }} *</label>
          <SearchableSelect
            v-model="orgId"
            :options="orgOptions"
            :placeholder="t('admin.pages.createTestOrder.selectOrg')"
          />
        </div>
        <div class="form-field">
          <label>{{ t("admin.pages.createTestOrder.subInventoryCode") }} *</label>
          <SearchableSelect
            v-model="subInventoryCode"
            :options="subInventoryOptions"
            :placeholder="t('admin.pages.createTestOrder.selectSubInventory')"
          />
        </div>
        <div class="form-field">
          <label>{{ t("admin.pages.createTestOrder.shipTo") }}</label>
          <input v-model="shipTo" type="text" />
        </div>
        <div class="form-field">
          <label>{{ t("admin.pages.createTestOrder.poNo") }}</label>
          <input v-model="poNo" type="text" />
        </div>
        <div class="form-field">
          <label>{{ t("admin.pages.createTestOrder.deliveryDate") }}</label>
          <input v-model="deliveryDate" type="date" />
        </div>
        <div class="form-field">
          <label>{{ t("admin.pages.createTestOrder.pickingOrderType") }}</label>
          <SearchableSelect
            v-model="pickingOrderType"
            :options="[
              { value: 'invoice', label: 'invoice' },
              { value: 'tn', label: 'tn' },
            ]"
            :placeholder="t('admin.pages.createTestOrder.selectType')"
          />
        </div>
        <div class="form-field">
          <label>{{ t("admin.pages.createTestOrder.prioritySeq") }}</label>
          <input v-model.number="prioritySeq" type="number" min="0" />
        </div>
        <div class="form-field form-field-full">
          <label>{{ t("admin.pages.createTestOrder.remark") }}</label>
          <input v-model="remark" type="text" />
        </div>
      </div>
    </section>

    <!-- Items -->
    <section class="form-section">
      <div class="section-header">
        <h2>{{ t("admin.pages.createTestOrder.items") }}</h2>
        <button class="btn btn-secondary btn-sm" @click="addItem">
          + {{ t("admin.pages.createTestOrder.addItem") }}
        </button>
      </div>

      <div class="items-table">
        <div class="items-header">
          <span class="col-line">{{ t("admin.pages.createTestOrder.line") }}</span>
          <span class="col-part">{{ t("admin.pages.createTestOrder.partNo") }} *</span>
          <span class="col-qty">{{ t("admin.pages.createTestOrder.qty") }} *</span>
          <span class="col-actions"></span>
        </div>
        <div v-for="(item, index) in items" :key="index" class="items-row">
          <span class="col-line">
            <input v-model.number="item.lineNumber" type="number" min="1" />
          </span>
          <span class="col-part">
            <SearchableSelect
              v-model="item.partNo"
              :options="partSearchOptions"
              :placeholder="t('admin.pages.createTestOrder.searchPart')"
              @update:search="searchParts"
            />
          </span>
          <span class="col-qty">
            <input v-model.number="item.qty" type="number" min="1" />
          </span>
          <span class="col-actions">
            <button class="btn btn-danger btn-sm" @click="removeItem(index)" :disabled="items.length === 1">
              ×
            </button>
          </span>
        </div>
      </div>
    </section>

    <!-- Error + Submit -->
    <div v-if="formError" class="alert alert-error">{{ formError }}</div>

    <div class="form-actions">
      <button class="btn btn-primary" @click="createOrder" :disabled="creating">
        {{ creating ? t("admin.pages.createTestOrder.creating") : t("admin.pages.createTestOrder.create") }}
      </button>
      <NuxtLink to="/picking-orders" class="btn btn-secondary">
        {{ t("admin.pages.createTestOrder.cancel") }}
      </NuxtLink>
    </div>
  </div>
</template>

<style scoped>
.page-container {
  padding: 24px;
  max-width: 1200px;
}

.page-header {
  margin-bottom: 24px;
}

.page-header h1 {
  font-size: 24px;
  font-weight: 600;
  margin: 0 0 4px;
}

.page-description {
  color: var(--text-secondary);
  margin: 0;
}

.action-bar {
  display: flex;
  gap: 8px;
  margin-bottom: 24px;
}

.form-section {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 20px;
  margin-bottom: 24px;
}

.form-section h2 {
  font-size: 16px;
  font-weight: 600;
  margin: 0 0 16px;
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.section-header h2 {
  margin: 0;
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 16px;
}

.form-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.form-field-full {
  grid-column: 1 / -1;
}

.form-field label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
}

.form-field input,
.form-field select {
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 4px;
  font-size: 14px;
}

.items-table {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.items-header,
.items-row {
  display: grid;
  grid-template-columns: 80px 1fr 120px 60px;
  gap: 8px;
  align-items: center;
}

.items-header {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  padding: 0 4px;
}

.items-row input,
.items-row select {
  width: 100%;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 4px;
  font-size: 14px;
}

.col-actions {
  text-align: center;
}

.alert {
  padding: 12px 16px;
  border-radius: 4px;
  margin-bottom: 16px;
  font-size: 14px;
}

.alert-error {
  background: var(--error-bg, #fef2f2);
  color: var(--error-text, #dc2626);
  border: 1px solid var(--error-border, #fecaca);
}

.form-actions {
  display: flex;
  gap: 8px;
}

.btn {
  padding: 8px 16px;
  border-radius: 4px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  border: 1px solid transparent;
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.btn-primary {
  background: var(--primary, #3b82f6);
  color: white;
}

.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-secondary {
  background: var(--surface);
  color: var(--text);
  border-color: var(--border);
}

.btn-danger {
  background: var(--error, #dc2626);
  color: white;
}

.btn-sm {
  padding: 4px 10px;
  font-size: 13px;
}
</style>
