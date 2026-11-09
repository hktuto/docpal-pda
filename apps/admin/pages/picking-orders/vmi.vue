<script setup lang="ts">
import { checkVmiDrafts, parseVmiAoa, vmiQty, type VmiIssue, type VmiOrderDraft } from "~/utils/vmiExcel";
import type { SearchableSelectOption } from "~/components/SearchableSelect.vue";
import type { VmiPickingOrderCreate } from "~/utils/flowApi";

// "New VMI" upload (spec 2026-11-09-vmi-picking-excel-upload-design.md):
// decode the VMI_Template_*.xlsx locally, gate it (parts master + sub-
// inventory → org_id), and on a clean sheet create one picking order per VMI
// Ref.No via POST /admin/picking-orders/vmi-create. Issues block creation —
// the fix path is a corrected re-upload (or the manual create page).

const flow = useFlowApi();
const { t } = useI18n();
const router = useRouter();
const parts = usePartsBrandCheck();

const fileInput = ref<HTMLInputElement | null>(null);
const orders = ref<VmiOrderDraft[]>([]);
const issues = ref<VmiIssue[]>([]);
const fileName = ref("");
const parsing = ref(false);
const creating = ref(false);
const error = ref("");
// Sub Inventory code → distinct org ids (GET /admin/sub-inventories).
const orgsBySubInv = ref<Map<string, number[]>>(new Map());
// All (org, sub-inventory) pairs for the "apply to all" picker.
const allLocations = ref<SearchableSelectOption[]>([]);
const allKey = ref("");

function triggerPick() {
  fileInput.value?.click();
}

async function onFilePicked(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = ""; // reset so the same file can be re-selected
  if (!file) return;
  parsing.value = true;
  error.value = "";
  issues.value = [];
  orders.value = [];
  fileName.value = file.name;
  try {
    const XLSX = await import("xlsx");
    const wb = XLSX.read(await file.arrayBuffer());
    // First sheet whose header row decodes (tolerates a cover tab).
    let parsed: VmiOrderDraft[] | null = null;
    for (const name of wb.SheetNames) {
      const ws = wb.Sheets[name];
      if (!ws) continue;
      const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" }) as unknown[][];
      if (aoa.length === 0) continue;
      try {
        parsed = parseVmiAoa(aoa);
        break;
      } catch {
        /* next sheet */
      }
    }
    if (!parsed) throw new Error(t("admin.pages.vmiUpload.noHeader"));
    orders.value = parsed;

    // Gates: sub-inventory → org_id + parts-master existence for every Item.
    const inv = await flow.listSubInventories();
    const orgs = new Map<string, number[]>();
    allLocations.value = inv
      .slice()
      .sort((a, b) => a.orgId - b.orgId || a.secondaryInventoryName.localeCompare(b.secondaryInventoryName))
      .map((row) => ({
        value: `${row.orgId}:${row.secondaryInventoryName}`,
        label: `${row.orgId} · ${row.secondaryInventoryName}`,
      }));
    for (const row of inv) {
      const list = orgs.get(row.secondaryInventoryName) ?? [];
      if (!list.includes(row.orgId)) list.push(row.orgId);
      orgs.set(row.secondaryInventoryName, list);
    }
    orgsBySubInv.value = orgs;
    allKey.value = "";
    // Unique match = decided; several orgs stay null until the admin picks
    // one from the dropdown below.
    for (const order of parsed) {
      const ids = orgs.get(order.subInventoryCode.trim()) ?? [];
      if (ids.length === 1) order.orgId = ids[0];
    }
    // Most VMI files use a single org + sub-inventory — reflect that in the
    // apply-to-all picker when the sheet already resolves uniformly.
    const first = parsed[0];
    if (
      first &&
      first.orgId !== null &&
      parsed.every((o) => o.orgId === first.orgId && o.subInventoryCode === first.subInventoryCode)
    )
      allKey.value = `${first.orgId}:${first.subInventoryCode}`;

    const keys = [...new Set(parsed.flatMap((o) => o.items.map((i) => i.partNo)).filter((k) => k !== ""))];
    if (keys.length > 0) {
      const failed = await parts.ensure(keys);
      // Never flag unknowns on a failed check (same rule as the CN gate).
      if (failed) throw new Error(t("admin.pages.vmiUpload.partsCheckFailed"));
    }
    runGate();
  } catch (err: any) {
    error.value = err?.message ?? String(err);
  } finally {
    parsing.value = false;
  }
}

function orgIdsOf(code: string): number[] {
  return orgsBySubInv.value.get(code.trim()) ?? [];
}

/** Per-order options: the orgs that actually have this order's sub-inventory. */
function orgOptions(order: VmiOrderDraft): SearchableSelectOption[] {
  return orgIdsOf(order.subInventoryCode).map((id) => ({
    value: String(id),
    label: `${id} · ${order.subInventoryCode}`,
  }));
}

/** Re-run the data gate on the current (possibly admin-overridden) rows. */
function runGate() {
  issues.value = checkVmiDrafts(
    orders.value,
    (k) => parts.check(k)?.found === true,
    orgIdsOf
  );
}

/** "Apply to all": set every order's org + sub-inventory from one pick. */
function applyAll(v: unknown) {
  const s = String(v ?? "");
  allKey.value = s;
  const sep = s.indexOf(":");
  if (sep <= 0) return;
  const orgId = Number(s.slice(0, sep));
  const code = s.slice(sep + 1);
  for (const o of orders.value) {
    o.subInventoryCode = code;
    o.orgId = orgId;
  }
  runGate();
}

const canCreate = computed(
  () =>
    orders.value.length > 0 &&
    issues.value.length === 0 &&
    orders.value.every((o) => o.orgId !== null) &&
    !parsing.value &&
    !creating.value
);

async function create() {
  if (!canCreate.value) return;
  creating.value = true;
  error.value = "";
  try {
    const body: VmiPickingOrderCreate[] = orders.value.map((o) => ({
      orderNo: o.orderNo,
      customerCode: o.customerCode || undefined,
      orgId: o.orgId!,
      subInventoryCode: o.subInventoryCode.trim(),
      shipTo: o.shipTo || undefined,
      poNo: o.poNo || undefined,
      items: o.items.map((item, i) => ({
        partNo: item.partNo,
        qty: vmiQty(item.qty)!,
        lineNumber: item.lineNumber ? Number(item.lineNumber) : i + 1,
        customerItem: item.customerItem || undefined,
      })),
    }));
    const res = await flow.createVmiPickingOrders(body);
    await router.push(`/picking-orders/${res.created[0]!.id}`);
  } catch (err: any) {
    error.value = err?.message ?? String(err);
    creating.value = false;
  }
}

function issueMessage(iss: VmiIssue): string {
  return t(`admin.pages.vmiUpload.issue.${iss.code}`, {
    orderNo: iss.orderNo,
    partNo: iss.partNo ?? "",
    qty: iss.qty ?? "",
    subInv: iss.subInv ?? "",
  });
}

function totalQty(order: VmiOrderDraft): number {
  return order.items.reduce((s, i) => s + (vmiQty(i.qty) ?? 0), 0);
}
</script>

<template>
  <div class="page-container">
    <div class="page-header">
      <h1>{{ t("admin.pages.vmiUpload.title") }}</h1>
      <p class="page-description">{{ t("admin.pages.vmiUpload.description") }}</p>
    </div>

    <div class="action-bar">
      <button class="btn btn-secondary" :disabled="parsing || creating" @click="triggerPick">
        {{ parsing ? t("admin.pages.vmiUpload.parsing") : t("admin.pages.vmiUpload.pickFile") }}
      </button>
      <span v-if="fileName" class="file-name">{{ fileName }}</span>
      <input
        ref="fileInput"
        type="file"
        accept=".xls,.xlsx"
        style="display: none"
        @change="onFilePicked"
      />
    </div>

    <div v-if="error" class="alert alert-error">{{ error }}</div>

    <div v-if="issues.length > 0" class="alert alert-error">
      <div>{{ t("admin.pages.vmiUpload.issuesTitle") }}</div>
      <ul class="issue-list">
        <li v-for="(iss, i) in issues" :key="i">{{ issueMessage(iss) }}</li>
      </ul>
    </div>

    <section v-if="orders.length > 0" class="form-section">
      <h2>{{ t("admin.pages.vmiUpload.summaryTitle", { n: orders.length }) }}</h2>
      <div v-if="orders.length > 1" class="apply-all">
        <span>{{ t("admin.pages.vmiUpload.applyToAll") }}</span>
        <div class="apply-all-select">
          <SearchableSelect
            :model-value="allKey"
            :options="allLocations"
            :multiple="false"
            :show-all="false"
            :all-label="t('admin.pages.vmiUpload.selectLocation')"
            :aria-label="t('admin.pages.vmiUpload.applyToAll')"
            @update:model-value="applyAll"
          />
        </div>
      </div>
      <div class="items-table">
        <div class="items-header">
          <span>{{ t("admin.pages.vmiUpload.ref") }}</span>
          <span>{{ t("admin.pages.vmiUpload.customer") }}</span>
          <span>{{ t("admin.pages.vmiUpload.location") }}</span>
          <span class="col-num">{{ t("admin.pages.vmiUpload.lines") }}</span>
          <span class="col-num">{{ t("admin.pages.vmiUpload.qty") }}</span>
        </div>
        <div v-for="(order, i) in orders" :key="`${order.orderNo}-${i}`" class="items-row">
          <span>{{ order.orderNo }}</span>
          <span>{{ order.customerCode }}</span>
          <span class="col-loc">
            <SearchableSelect
              :model-value="order.orgId === null ? '' : String(order.orgId)"
              :options="orgOptions(order)"
              :multiple="false"
              :show-all="false"
              :all-label="t('admin.pages.vmiUpload.selectOrg')"
              :aria-label="t('admin.pages.vmiUpload.location')"
              @update:model-value="(v: unknown) => (order.orgId = v === '' ? null : Number(v))"
            />
          </span>
          <span class="col-num">{{ order.items.length }}</span>
          <span class="col-num">{{ totalQty(order) }}</span>
        </div>
      </div>
    </section>

    <div class="form-actions">
      <button class="btn btn-primary" :disabled="!canCreate" @click="create">
        {{ creating ? t("admin.pages.vmiUpload.creating") : t("admin.pages.vmiUpload.create", { n: orders.length }) }}
      </button>
      <NuxtLink to="/picking-orders" class="btn btn-secondary">{{ t("admin.pages.vmiUpload.cancel") }}</NuxtLink>
    </div>
  </div>
</template>

<style scoped>
.page-container {
  padding: 24px;
  max-width: 900px;
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
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}

.file-name {
  font-size: 14px;
  color: var(--text-secondary);
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

.issue-list {
  margin: 8px 0 0;
  padding-left: 20px;
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

.items-table {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.apply-all {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
  font-size: 14px;
  color: var(--text-secondary);
}

.apply-all-select {
  width: 260px;
}

.col-loc {
  min-width: 0;
}

.items-header,
.items-row {
  display: grid;
  grid-template-columns: 1.2fr 1fr 1.4fr 60px 90px;
  gap: 8px;
  align-items: center;
  font-size: 14px;
}

.items-header {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  padding: 0 4px;
}

.col-num {
  text-align: right;
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
</style>
