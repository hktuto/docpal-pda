<script setup lang="ts">
import type { SearchableSelectOption } from "~/components/SearchableSelect.vue";
import type {
  CustomerAccountRow,
  InventoryLabelRow,
  PickingOrderItemDraft,
  TestPickingOrderCreate,
  TestPickingOrderTemplate,
} from "~/utils/flowApi";

const flow = useFlowApi();
const { t } = useI18n();
const router = useRouter();

// ---- Order header form state ----
const orderNo = ref("");
const customerCode = ref(""); // customer_accounts.party_name (dropdown)
// Combined inventory-label location ("orgId:subInventoryCode") — the form's
// single source for the org + sub-inventory pair sent to the API.
const locationKey = ref("");
const orgId = ref<number | null>(null);
const subInventoryCode = ref("");
const shipTo = ref("");
const poNo = ref("");
const deliveryDate = ref("");
const pickingOrderType = ref("");
const prioritySeq = ref(0);
const remark = ref("");

// ---- Dropdown sources ----
const customerAccounts = ref<CustomerAccountRow[]>([]);
const inventoryLabels = ref<InventoryLabelRow[]>([]);

const customerOptions = computed<SearchableSelectOption[]>(() =>
  customerAccounts.value.map((c) => ({
    value: c.partyName,
    label: `${c.partyName} (${c.accountNumber})`,
  }))
);

const locationOptions = computed<SearchableSelectOption[]>(() => {
  const opts = inventoryLabels.value
    .filter((l) => l.isActive)
    .sort(
      (a, b) =>
        a.orgId - b.orgId || a.sortOrder - b.sortOrder || a.subInventoryCode.localeCompare(b.subInventoryCode)
    )
    .map((l) => ({
      value: `${l.orgId}:${l.subInventoryCode}`,
      label:
        l.label === l.subInventoryCode
          ? `${l.orgId} · ${l.subInventoryCode}`
          : `${l.orgId} · ${l.subInventoryCode} — ${l.label}`,
    }));
  // Fallback for a pair missing from inventory_labels (e.g. imported JSON).
  const key = locationKey.value;
  if (key && !opts.some((o) => o.value === key)) opts.unshift({ value: key, label: key });
  return opts;
});

watch(locationKey, (key) => {
  const sep = key.indexOf(":");
  if (sep === -1) {
    orgId.value = null;
    subInventoryCode.value = "";
    return;
  }
  const org = Number(key.slice(0, sep));
  orgId.value = Number.isFinite(org) && key.slice(0, sep) !== "" ? org : null;
  subInventoryCode.value = key.slice(sep + 1);
});

// ---- Items (managed by the add/edit dialog — the table starts empty) ----
const items = ref<PickingOrderItemDraft[]>([]);

const itemDialogOpen = ref(false);
const editingIndex = ref<number | null>(null);

const editingItem = computed(() =>
  editingIndex.value === null ? null : (items.value[editingIndex.value] ?? null)
);

function openAddItem() {
  editingIndex.value = null;
  itemDialogOpen.value = true;
}

function openEditItem(index: number) {
  editingIndex.value = index;
  itemDialogOpen.value = true;
}

function closeItemDialog() {
  itemDialogOpen.value = false;
  editingIndex.value = null;
}

function saveItem(item: PickingOrderItemDraft) {
  if (editingIndex.value === null) items.value.push(item);
  else items.value[editingIndex.value] = item;
  closeItemDialog();
}

function removeItem(index: number) {
  items.value.splice(index, 1);
}

// ---- Form validation ----
const formError = ref("");

function validate(): string {
  if (!orderNo.value.trim()) return t("admin.pages.createTestOrder.errors.orderNoRequired");
  if (orgId.value === null || !subInventoryCode.value)
    return t("admin.pages.createTestOrder.errors.locationRequired");
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
    locationKey.value = `${template.orgId}:${template.subInventoryCode}`;
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
      wclItemNo: null,
      brand: null,
      description: null,
      qty: item.qty,
      lineNumber: item.lineNumber ?? i + 1,
    }));
  } catch (err: any) {
    importError.value = err?.message ?? "Failed to parse template JSON";
  } finally {
    input.value = "";
  }
}

// ---- Load dropdown sources on mount ----
onMounted(async () => {
  const [customers, labels] = await Promise.all([flow.listCustomerAccounts(), flow.listInventoryLabels()]);
  customerAccounts.value = customers;
  inventoryLabels.value = labels;
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
          <SearchableSelect
            v-model="customerCode"
            :options="customerOptions"
            :multiple="false"
            :all-label="t('admin.pages.createTestOrder.selectCustomer')"
          />
        </div>
        <div class="form-field">
          <label>{{ t("admin.pages.createTestOrder.location") }} *</label>
          <SearchableSelect
            v-model="locationKey"
            :options="locationOptions"
            :multiple="false"
            :all-label="t('admin.pages.createTestOrder.selectLocation')"
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
            :multiple="false"
            :all-label="t('admin.pages.createTestOrder.selectType')"
          />
        </div>
        <div class="form-field">
          <label>{{ t("admin.pages.createTestOrder.prioritySeq") }}</label>
          <input v-model.number="prioritySeq" type="number" min="0" />
        </div>
        <div class="form-field form-field-full">
          <label>{{ t("admin.pages.createTestOrder.remark") }}</label>
          <textarea v-model="remark" rows="3" />
        </div>
      </div>
    </section>

    <!-- Items -->
    <section class="form-section">
      <div class="section-header">
        <h2>{{ t("admin.pages.createTestOrder.items") }}</h2>
        <button class="btn btn-secondary btn-sm" @click="openAddItem">
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
        <div v-if="items.length === 0" class="items-empty">
          {{ t("admin.pages.createTestOrder.noItems") }}
        </div>
        <div v-for="(item, index) in items" :key="index" class="items-row">
          <span class="col-line">{{ item.lineNumber ?? index + 1 }}</span>
          <span class="col-part">
            {{ item.partNo }}<span v-if="item.wclItemNo"> ({{ item.wclItemNo }})</span>
          </span>
          <span class="col-qty">{{ item.qty }}</span>
          <span class="col-actions actions-cell">
            <button class="btn btn-secondary btn-sm" @click="openEditItem(index)">
              {{ t("admin.common.edit") }}
            </button>
            <button class="btn btn-danger btn-sm" @click="removeItem(index)">×</button>
          </span>
        </div>
      </div>
    </section>

    <!-- Add / edit item dialog -->
    <PickingOrdersItemFormModal
      :open="itemDialogOpen"
      :item="editingItem"
      :next-line-number="items.length + 1"
      @close="closeItemDialog"
      @save="saveItem"
    />

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
.form-field select,
.form-field textarea {
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 4px;
  font-size: 14px;
  font-family: inherit;
}

.form-field textarea {
  resize: vertical;
}

.items-table {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.items-header,
.items-row {
  display: grid;
  grid-template-columns: 60px 1fr 90px 130px;
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

.items-empty {
  padding: 16px;
  text-align: center;
  font-size: 14px;
  color: var(--text-secondary);
  border: 1px dashed var(--border);
  border-radius: 4px;
}

.actions-cell {
  display: flex;
  gap: 4px;
  justify-content: center;
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
