<script setup lang="ts">
// Status-driven body view for the picking-order detail page (placeholder
// step of the staged-view refactor, spec
// docs/superpowers/specs/2026-11-12-picking-order-detail-staged-views-design.md):
// every status currently renders this same "everything" view. Later each
// stage gets its own focused view (pending → allocation, picking → progress,
// …) carved out of this component; the page picks the view by status.
import type {
  AdminUserRow,
  CountryRow,
  OrderLogsParams,
  OrderLogsPage,
  PickingItemRow,
  PickingOrderDetail,
  SubInventoryRow,
  TaskAssignmentFlow,
} from "~/utils/flowApi";
import type { AdminColumnDef } from "~/composables/useAdminTable";
import type { SearchableSelectOption } from "~/components/SearchableSelect.vue";

const props = defineProps<{
  order: PickingOrderDetail;
  /** Audit-log refresh key — bumped by page-level mutations too. */
  logsKey: number;
  /** Reload the order (and the page's audit-log key) after a mutation. */
  refresh: () => Promise<void>;
}>();

const route = useRoute();
const orderId = route.params.id as string;
const flow = useFlowApi();
const { t } = useI18n();
// Allocation lots/packages store canonical YYWW — formatDcLabel converts to
// the label/operator format before rendering the display template.
const { formatLabel: formatDcLabel } = useDateCodeDisplay();

const error = ref("");

// The audit-log table fetches itself; the page bumps logsKey after
// mutations that write logs (both view-internal and page-head actions).
const fetchLogs = (p: OrderLogsParams): Promise<OrderLogsPage> => flow.listPickingOrderLogs(orderId, p);

const deliveryDate = ref("");

// Info-section edit (delivery date, ship-to, location pair) — one Save
// button at the section's bottom right PATCHes all three in one call.
// Ship-to is a country dropdown (show name, store the country_list code);
// the location pair is a composite FK to org_info, so it must be set
// together (both empty clears it) and the backend schedules an allocation
// recompute on change.
const shipToInput = ref(""); // country code; "" = none
const savingInfo = ref(false);
const infoSaved = ref(false);

const countries = ref<CountryRow[]>([]);
const countryOptions = computed<SearchableSelectOption[]>(() =>
  [...countries.value].sort((a, b) => a.name.localeCompare(b.name, undefined,  { sensitivity: 'base' })).map((c) => ({ value: c.code, label: c.name }))
);

const subInventories = ref<SubInventoryRow[]>([]);
const editOrgId = ref(""); // "" = none
const editSubInventory = ref(""); // "" = none
const locationError = ref("");

// Per-step assignee pickers (spec 2026-11-01 + CR-048): the order's picking /
// labeling / label-printing steps and the per-box measuring / verify steps.
// All save through the generic PATCH /admin/task-assignment (optimistic,
// rolled back on error); state is keyed `${flow}:${taskId}`, value = username
// ("" = unassigned).
const assigneeUsers = ref<AdminUserRow[]>([]);
const assigneeOptions = computed<SearchableSelectOption[]>(() =>
  assigneeUsers.value.map((u) => ({ value: u.username, label: `${u.displayName} (${u.username})` }))
);
const assigneeInputs = ref<Record<string, string>>({});
const assigneeSaving = ref<Record<string, boolean>>({});

function assigneeValue(taskFlow: TaskAssignmentFlow, id: string) {
  return assigneeInputs.value[`${taskFlow}:${id}`] ?? "";
}

async function saveStepAssignee(taskFlow: TaskAssignmentFlow, id: string, value: string[] | string) {
  const key = `${taskFlow}:${id}`;
  const next = typeof value === "string" ? value : "";
  const prev = assigneeInputs.value[key] ?? "";
  if (next === prev || assigneeSaving.value[key]) return;
  assigneeInputs.value = { ...assigneeInputs.value, [key]: next };
  assigneeSaving.value = { ...assigneeSaving.value, [key]: true };
  error.value = "";
  try {
    await flow.setTaskAssignment(taskFlow, id, next || null);
    await props.refresh();
  } catch (e: any) {
    assigneeInputs.value = { ...assigneeInputs.value, [key]: prev };
    error.value = `${t("taskAssignments.saveFailed")}: ${e?.message ?? String(e)}`;
  } finally {
    assigneeSaving.value = { ...assigneeSaving.value, [key]: false };
  }
}

/** Seed every picker from the loaded order (re-run on each reload). */
function initAssigneeInputs(o: PickingOrderDetail) {
  const inputs: Record<string, string> = {
    [`picking:${orderId}`]: o.assignee ?? "",
    [`labeling:${orderId}`]: o.labelingAssignee ?? "",
    [`label-printing:${orderId}`]: o.labelPrintingAssignee ?? "",
  };
  for (const b of o.boxes) {
    inputs[`measuring:${b.id}`] = b.assignee ?? "";
    if (b.verifyTaskId) inputs[`verify:${b.verifyTaskId}`] = b.verifyAssignee ?? "";
  }
  assigneeInputs.value = inputs;
}

const orgOptions = computed<SearchableSelectOption[]>(() => {
  const seen = new Set<number>();
  for (const r of subInventories.value) seen.add(r.orgId);
  return [...seen].sort((a, b) => a - b).map((o) => ({ value: String(o), label: String(o) }));
});

const subInventoryOptions = computed<SearchableSelectOption[]>(() =>
  subInventories.value
    .filter((r) => String(r.orgId) === editOrgId.value)
    .map((r) => ({
      value: r.secondaryInventoryName,
      label: r.subinvDescription ? `${r.secondaryInventoryName} — ${r.subinvDescription}` : r.secondaryInventoryName,
    }))
);

// A sub-inventory code only exists under its own org — drop the selection
// when the org changes to one that doesn't have it.
watch(editOrgId, () => {
  if (editSubInventory.value && !subInventoryOptions.value.some((o) => o.value === editSubInventory.value)) {
    editSubInventory.value = "";
  }
});

// Issue resolution (status === 'issue'): optional note, then back to pending.
const resolvingIssue = ref(false);

// "Report issue" modal: admin-side picking issue report (mirrors the PDA's
// PickingIssueReportModal for a single order; merge is PDA-only since it
// needs a multi-order selection).
const PICKING_ISSUE_REASONS = ["insufficient_stock", "cannot_divide", "other"] as const;

const reportOpen = ref(false);
const reportReason = ref("");

const reportReasonOptions = computed<SearchableSelectOption[]>(() =>
  PICKING_ISSUE_REASONS.map((r) => ({ value: r, label: t(`picking.issueReasons.${r}`) }))
);
const reportQtyInput = ref("");
const reportPackSizeInput = ref("");
const reportNote = ref("");
const reportRemark = ref("");
const reportError = ref("");
const reportSubmitting = ref(false);
const reportDismiss = useOverlayDismiss(() => (reportOpen.value = false));

const totalQty = computed(() => (props.order.items ?? []).filter((i) => i.status !== "cancelled").reduce((sum, i) => sum + i.qty, 0));

// Items table view modes: "flat" (one row per order line — the original) and
// "grouped" (lines sharing the same item no (wclItemNo ?? partNo) merge into
// one row with summed qtys; the 🔍 availability modal opens on the whole part
// group — one Confirm re-allocates every line at once — while the per-line
// allocation remove buttons stay in flat mode). In grouped mode allocations
// from the same location + date code + COO merge into one row with a summed
// qty.
type ItemsViewRow = PickingItemRow & {
  grouped?: boolean;
  lineLabel?: string;
  /** Grouped rows only: the member lines' UNMERGED allocation rows — the
   *  availability modal's per-source baseline (the merged display rows lose
   *  the lot/receiving-item id mapping). */
  groupAllocations?: PickingItemRow["allocations"];
};

const itemsView = ref<"flat" | "grouped">("flat");

function allocationGroupKey(a: PickingItemRow["allocations"][number]): string {
  if (a.lot) {
    // Lot source: location = shelf + box, plus date code and COO.
    return ["lot", a.lot.shelfCode ?? "", a.lot.boxId ?? "", a.lot.dateCode ?? "", a.lot.coo ?? ""].join("|");
  }
  // Receiving source: the source order + carton box and its date code.
  return ["rec", a.receivingOrderId ?? a.receiving?.orderId ?? "", a.boxId ?? "", a.receiving?.dateCode ?? ""].join("|");
}

function mergeAllocations(list: PickingItemRow["allocations"]): PickingItemRow["allocations"] {
  const merged = new Map<string, PickingItemRow["allocations"][number]>();
  for (const a of list) {
    const key = allocationGroupKey(a);
    const existing = merged.get(key);
    if (existing) existing.qty += a.qty;
    else merged.set(key, { ...a });
  }
  return [...merged.values()];
}

const groupedItems = computed<ItemsViewRow[]>(() => {
  const groups = new Map<string, { row: ItemsViewRow; lines: Set<string> }>();
  for (const item of props.order.items ?? []) {
    const key = item.wclItemNo ?? item.partNo;
    let g = groups.get(key);
    if (!g) {
      g = {
        row: {
          ...item,
          id: `group:${key}`,
          grouped: true,
          lineLabel: "",
          qty: 0,
          allocatedQty: 0,
          pickedQty: 0,
          allocations: [],
          packages: [],
          groupAllocations: [],
        },
        lines: new Set(),
      };
      groups.set(key, g);
    }
    g.row.qty += item.qty;
    g.row.allocatedQty += item.allocatedQty;
    g.row.pickedQty += item.pickedQty;
    g.lines.add(`${item.lineNumber ?? "—"} / ${item.shipmentNumber ?? "—"}`);
    g.row.allocations.push(...item.allocations);
    g.row.groupAllocations!.push(...item.allocations);
    g.row.packages.push(...item.packages);
  }
  for (const g of groups.values()) {
    g.row.lineLabel = [...g.lines].join(", ");
    g.row.allocations = mergeAllocations(g.row.allocations);
  }
  return [...groups.values()].map((g) => g.row);
});

const itemsViewRows = computed<ItemsViewRow[]>(() =>
  itemsView.value === "grouped" ? groupedItems.value : (props.order.items ?? [])
);

// Cancelled lines (cancel-invoice cron) strike through in the flat item table.
const itemsRowClass = (row: ItemsViewRow) => (!row.grouped && row.status === "cancelled" ? "row-cancelled" : "");

// Detail lists are small and were previously shown in full — no Pager, so
// the tables get a generous default page size (TanStack still owns sorting).
const itemsColumnDefs = computed<AdminColumnDef<PickingOrderDetail["items"][number]>[]>(() => [
  {
    key: "partNo",
    label: t("admin.fields.partNo"),
    accessor: (item) => item.wclItemNo ?? item.partNo,
    size: 150,
  },
  {
    key: "line",
    label: t("admin.pages.pickingOrders.line"),
    accessor: (item) => (item.grouped ? (item.lineLabel ?? "") : (item.lineNumber ?? 0)),
    size: 110,
  },
  { key: "qty", label: t("admin.pages.pickingOrders.required"), size: 90 },
  {
    key: "status",
    label: t("admin.pages.pickingOrders.status"),
    accessor: (item) => (item.grouped ? "" : t(`admin.pages.pickingOrders.itemStatus.${item.status ?? ""}`)),
    size: 90,
  },
  { key: "allocatedQty", label: t("admin.pages.pickingOrders.allocated"), size: 90 },
  { key: "pickedQty", label: t("admin.pages.pickingOrders.picked"), size: 80 },
  {
    key: "allocations",
    label: t("admin.pages.pickingOrders.allocations"),
    accessor: (item) => item.allocations.length,
    size: 240,
  },
  {
    key: "packages",
    label: t("admin.pages.pickingOrders.packages"),
    accessor: (item) => item.packages.length,
    size: 240,
  },
]);

const { table: itemsTable, resetColumnState: resetItemsColumns } = useAdminTable({
  tableId: "picking-detail-items",
  columns: itemsColumnDefs,
  rows: itemsViewRows,
  getRowId: (item) => item.id,
  defaultPageSize: 100,
});

const boxesColumnDefs = computed<AdminColumnDef<PickingOrderDetail["boxes"][number]>[]>(() => [
  { key: "id", label: t("admin.pages.pickingOrders.boxId"), size: 130 },
  { key: "status", label: t("admin.pages.pickingOrders.status"), size: 140 },
  { key: "boxSize", label: t("admin.pages.pickingOrders.size"), size: 80 },
  {
    key: "netGross",
    label: t("admin.pages.pickingOrders.netGross"),
    accessor: (b) => b.netWeight ?? 0,
    size: 110,
  },
  { key: "destinationCountry", label: t("admin.pages.pickingOrders.destination"), size: 130 },
  { key: "packageCount", label: t("admin.pages.pickingOrders.packages"), size: 100 },
  {
    key: "measuringAssignee",
    label: t("admin.pages.pickingOrders.measuringAssignee"),
    accessor: (b) => b.assignee ?? "",
    size: 170,
  },
  {
    key: "verifyAssignee",
    label: t("admin.pages.pickingOrders.verifyAssignee"),
    accessor: (b) => b.verifyAssignee ?? "",
    size: 170,
  },
]);

const boxesRows = computed(() => props.order.boxes ?? []);

const { table: boxesTable, resetColumnState: resetBoxesColumns } = useAdminTable({
  tableId: "picking-detail-boxes",
  columns: boxesColumnDefs,
  rows: boxesRows,
  getRowId: (b) => b.id,
  defaultPageSize: 100,
});

function openReportModal() {
  reportReason.value = "";
  reportQtyInput.value = "";
  reportPackSizeInput.value = "";
  reportNote.value = "";
  reportRemark.value = "";
  reportError.value = "";
  reportOpen.value = true;
}

// Returns an admin.pages.pickingOrders.reportErr* key, or null when valid.
function validateReport(): string | null {
  const reason = reportReason.value;
  if (!reason) return "reportErrReasonRequired";
  if (reason === "insufficient_stock") {
    const qty = reportQtyInput.value.trim() === "" ? null : Number(reportQtyInput.value);
    if (qty === null || !Number.isInteger(qty) || qty < 0) return "reportErrQtyRequired";
    if (qty >= totalQty.value) return "reportErrQtyExceedsRequested";
  }
  if (reason === "cannot_divide") {
    const packSize = reportPackSizeInput.value.trim() === "" ? null : Number(reportPackSizeInput.value);
    if (packSize === null || !Number.isInteger(packSize) || packSize <= 0) return "reportErrPackSizeRequired";
  }
  return null;
}

async function submitReport() {
  const errKey = validateReport();
  if (errKey) {
    reportError.value = t(`admin.pages.pickingOrders.${errKey}`, { qty: totalQty.value });
    return;
  }
  reportSubmitting.value = true;
  reportError.value = "";
  try {
    const entry: { reason: string; qty?: number; packSize?: number; note?: string; remark?: string } = {
      reason: reportReason.value,
    };
    if (reportReason.value === "insufficient_stock") entry.qty = Number(reportQtyInput.value);
    if (reportReason.value === "cannot_divide") entry.packSize = Number(reportPackSizeInput.value);
    const note = reportNote.value.trim();
    if (note) entry.note = note;
    const remark = reportRemark.value.trim();
    if (remark) entry.remark = remark;
    await flow.reportPickingIssue(orderId, entry);
    reportOpen.value = false;
    await props.refresh();
  } catch (e: any) {
    reportError.value = e.message;
  } finally {
    reportSubmitting.value = false;
  }
}

async function saveInfo() {
  infoSaved.value = false;
  locationError.value = "";
  const orgSet = editOrgId.value !== "";
  const subSet = editSubInventory.value !== "";
  if (orgSet !== subSet) {
    locationError.value = t("admin.pages.pickingOrders.locationPairRequired");
    return;
  }
  savingInfo.value = true;
  error.value = "";
  try {
    await flow.updatePickingOrder(orderId, {
      deliveryDate: deliveryDate.value || null,
      shipTo: shipToInput.value || null,
      orgId: orgSet ? Number(editOrgId.value) : null,
      subInventoryCode: subSet ? editSubInventory.value : null,
    });
    await props.refresh();
    infoSaved.value = true;
  } catch (e: any) {
    error.value = e.message;
  } finally {
    savingInfo.value = false;
  }
}

// "Re-allocate": awaited recompute scoped to THIS order only — only this
// order's allocation rows are wiped/rebuilt; other orders sharing a part
// number keep their rows untouched (spec
// docs/superpowers/specs/2026-11-05-picking-reallocate-single-order-design.md).
const reallocating = ref(false);
const reallocDoneMs = ref(0);
let reallocTimer: ReturnType<typeof setTimeout> | undefined;

async function reallocate() {
  if (reallocating.value) return;
  if (!window.confirm(t("admin.pages.pickingOrders.reallocateConfirm", { orderNo: props.order.orderNo }))) return;
  reallocating.value = true;
  error.value = "";
  const startedAt = Date.now();
  try {
    await flow.reallocatePickingOrder(orderId);
    await props.refresh();
    clearTimeout(reallocTimer);
    reallocDoneMs.value = Date.now() - startedAt;
    reallocTimer = setTimeout(() => {
      reallocDoneMs.value = 0;
    }, 8000);
  } catch (e: any) {
    // 409 lock_held carries a JSON body ({error, holderId, holderName}) —
    // the api client throws the raw body text as the message.
    let handled = false;
    try {
      const body = JSON.parse(e.message);
      if (body?.error === "lock_held") {
        error.value = t("admin.pages.pickingOrders.reallocateLocked", {
          orderNo: props.order.orderNo,
          name: body.holderName ?? body.holderId,
        });
        handled = true;
      }
    } catch {
      // not JSON — fall through to the raw message
    }
    if (!handled) error.value = e.message;
  } finally {
    reallocating.value = false;
  }
}

onBeforeUnmount(() => clearTimeout(reallocTimer));

// Per-allocation "Remove" (x): DELETEs that one allocation row. No order
// status check (admins may fix allocations in any state); 409 lock_held
// carries the same JSON body as reallocate.
const removingAlloc = ref<Record<string, boolean>>({});

async function removeAllocation(
  item: PickingOrderDetail["items"][number],
  alloc: PickingOrderDetail["items"][number]["allocations"][number]
) {
  if (removingAlloc.value[alloc.id]) return;
  const partNo = item.wclItemNo ?? item.partNo;
  if (!window.confirm(t("admin.pages.pickingOrders.removeAllocationConfirm", { partNo, qty: alloc.qty }))) return;
  removingAlloc.value = { ...removingAlloc.value, [alloc.id]: true };
  error.value = "";
  try {
    await flow.removePickingAllocation(orderId, item.id, alloc.id);
    await props.refresh();
  } catch (e: any) {
    let handled = false;
    try {
      const body = JSON.parse(e.message);
      if (body?.error === "lock_held") {
        error.value = t("admin.pages.pickingOrders.reallocateLocked", {
          orderNo: props.order.orderNo,
          name: body.holderName ?? body.holderId,
        });
        handled = true;
      }
    } catch {
      // not JSON — fall through to the raw message
    }
    if (!handled) error.value = e.message;
  } finally {
    removingAlloc.value = { ...removingAlloc.value, [alloc.id]: false };
  }
}

// "Search availability" modal (PartAvailabilityModal): stock lots + open
// receiving sources for the item's part, with manual-allocation pins. The
// component fetches itself on open; on each successful Allocate we refresh
// the order and the audit logs.
const availOpen = ref(false);
const availItem = ref<PickingOrderDetail["items"][number] | null>(null);
// Target picking item ids for the availability lookup: the single item, or
// every member line of a group. The backend resolves the search partition
// from these (a tn line searches its from_subinventory source partition).
const availItemIds = ref<string[]>([]);
// Set instead of availItem when the modal is opened from a GROUPED row: the
// form then works on the whole part group (summed qtys + the member lines'
// unmerged allocations) and submits to allocate-group.
const availGroup = ref<{
  partNo: string;
  wclItemNo: string | null;
  qty: number;
  pickedQty: number;
  allocations: PickingItemRow["allocations"];
} | null>(null);

async function onAllocated() {
  await props.refresh();
}

function openAvailability(item: ItemsViewRow) {
  if (item.grouped) {
    availItem.value = null;
    const key = item.wclItemNo ?? item.partNo;
    availItemIds.value = (props.order.items ?? [])
      .filter((i) => (i.wclItemNo ?? i.partNo) === key)
      .map((i) => i.id);
    availGroup.value = {
      partNo: item.partNo,
      wclItemNo: item.wclItemNo ?? null,
      qty: item.qty,
      pickedQty: item.pickedQty,
      allocations: item.groupAllocations ?? [],
    };
  } else {
    availGroup.value = null;
    availItem.value = item;
    availItemIds.value = [item.id];
  }
  availOpen.value = true;
}

async function resolveIssue() {
  const note = window.prompt(t("admin.pages.pickingOrders.resolvePrompt"));
  if (note === null) return;
  resolvingIssue.value = true;
  error.value = "";
  try {
    await flow.resolvePickingIssue(orderId, note);
    await props.refresh();
  } catch (e: any) {
    error.value = e.message;
  } finally {
    resolvingIssue.value = false;
  }
}

// "Confirm allocation": one-click shortcut for pending orders — stamps the
// order `allocated` (the allocation lock) through the same status-override
// endpoint, without opening the override dialog.
const confirmingAllocation = ref(false);

async function confirmAllocation() {
  if (confirmingAllocation.value) return;
  confirmingAllocation.value = true;
  error.value = "";
  try {
    await flow.overridePickingOrderStatus(orderId, "allocated", t("admin.pages.pickingOrders.confirmAllocation"));
    await props.refresh();
  } catch (e: any) {
    error.value = e.message;
  } finally {
    confirmingAllocation.value = false;
  }
}

function allocationSource(a: PickingOrderDetail["items"][number]["allocations"][number]): string {
  if (a.lot)
    return t("admin.pages.pickingOrders.allocLot", {
      shelf: a.lot.shelfCode ?? "",
      box: a.lot.boxId ? ` / ${a.lot.boxId}` : "",
      dc: formatDcLabel(a.lot) || "—",
    });
  if (a.receivingInvoiceItemId) return t("admin.pages.pickingOrders.allocReceivingBox", { box: a.boxId ?? "" });
  if (a.receivingOrderId) return t("admin.pages.pickingOrders.allocReceivingOrder");
  return "—";
}

// Fetch the dropdown sources once (pickers stay empty on failure; the order
// still renders) and sync edit inputs from the order prop on each reload.
onMounted(() => {
  flow
    .listSubInventories()
    .then((rows) => (subInventories.value = rows))
    .catch(() => {}); // picker options stay empty; the order still loads
  flow
    .listCountries()
    .then((rows) => (countries.value = rows))
    .catch(() => {});
  flow
    .listAdminUsers()
    .then((rows) => (assigneeUsers.value = rows))
    .catch(() => {}); // picker options stay empty; the order still loads
});

watch(
  () => props.order,
  (o) => {
    deliveryDate.value = o.deliveryDate ? o.deliveryDate.slice(0, 10) : "";
    shipToInput.value = o.shipTo ?? "";
    editOrgId.value = o.orgId != null ? String(o.orgId) : "";
    editSubInventory.value = o.subInventoryCode ?? "";
    initAssigneeInputs(o);
  },
  { immediate: true }
);

// The busy flag used by the page's change-notice banner: body modals that
// must suppress the silent SSE reload.
defineExpose({
  changeBusy: computed(() => reportOpen.value || availOpen.value),
  // Stage-action state + handlers driven by the page-head buttons
  // (re-allocate / report issue / confirm allocation live in the header).
  reallocating: computed(() => reallocating.value),
  confirmingAllocation: computed(() => confirmingAllocation.value),
  reallocate,
  openReportModal,
  confirmAllocation,
});
</script>

<template>
  <div>
    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-if="reallocDoneMs" class="alloc-done-banner">
      {{ $t("admin.pages.pickingOrders.allocationDoneIn", { ms: reallocDoneMs }) }}
    </div>

    <div class="detail-grid">
      <div><div class="dt">{{ $t("admin.pages.pickingOrders.status") }}</div><div class="dd">{{ $t(`status.picking.${order.status}`) }}</div></div>
      <div>
        <div class="dt">{{ $t("admin.pages.pickingOrders.assigneePicking") }}</div>
        <div class="dd date-edit">
          <SearchableSelect
            :model-value="assigneeValue('picking', orderId)"
            :options="assigneeOptions"
            :all-label="$t('taskAssignments.unassigned')"
            :aria-label="$t('admin.pages.pickingOrders.assigneePicking')"
            :multiple="false"
            :disabled="!!assigneeSaving['picking:' + orderId]"
            class="ship-to-select"
            @update:model-value="saveStepAssignee('picking', orderId, $event)"
          />
        </div>
      </div>
      <div>
        <div class="dt">{{ $t("admin.pages.pickingOrders.assigneeLabeling") }}</div>
        <div class="dd date-edit">
          <SearchableSelect
            :model-value="assigneeValue('labeling', orderId)"
            :options="assigneeOptions"
            :all-label="$t('taskAssignments.unassigned')"
            :aria-label="$t('admin.pages.pickingOrders.assigneeLabeling')"
            :multiple="false"
            :disabled="!!assigneeSaving['labeling:' + orderId]"
            class="ship-to-select"
            @update:model-value="saveStepAssignee('labeling', orderId, $event)"
          />
        </div>
      </div>
      <div>
        <div class="dt">{{ $t("admin.pages.pickingOrders.assigneeLabelPrinting") }}</div>
        <div class="dd date-edit">
          <SearchableSelect
            :model-value="assigneeValue('label-printing', orderId)"
            :options="assigneeOptions"
            :all-label="$t('taskAssignments.unassigned')"
            :aria-label="$t('admin.pages.pickingOrders.assigneeLabelPrinting')"
            :multiple="false"
            :disabled="!!assigneeSaving['label-printing:' + orderId]"
            class="ship-to-select"
            @update:model-value="saveStepAssignee('label-printing', orderId, $event)"
          />
        </div>
      </div>
      <div v-if="order.labelPrintingPending || order.labelPrintingDoneAt">
        <div class="dt">{{ $t("admin.pages.pickingOrders.labelPrinting") }}</div>
        <div class="dd">
          <template v-if="order.labelPrintingPending">{{ $t("admin.pages.pickingOrders.labelPrintingPending") }}</template>
          <template v-else>
            {{ $t("admin.pages.pickingOrders.labelPrintingDone", {
              at: order.labelPrintingDoneAt ? formatDateTime(order.labelPrintingDoneAt) : "—",
              by: order.labelPrintingDoneByName ?? order.labelPrintingDoneBy ?? "—",
            }) }}
          </template>
        </div>
      </div>
      <div v-if="order.labelingPending || order.labelingDoneAt">
        <div class="dt">{{ $t("admin.pages.pickingOrders.labeling") }}</div>
        <div class="dd">
          <template v-if="order.labelingPending">{{ $t("admin.pages.pickingOrders.labelingPending") }}</template>
          <template v-else>
            {{ $t("admin.pages.pickingOrders.labelingDone", {
              at: order.labelingDoneAt ? formatDateTime(order.labelingDoneAt) : "—",
              by: order.labelingDoneByName ?? order.labelingDoneBy ?? "—",
            }) }}
          </template>
        </div>
      </div>
      <div><div class="dt">{{ $t("admin.pages.pickingOrders.customer") }}</div><div class="dd">{{ order.customerCode ?? "—" }}</div></div>
      <!-- <div><div class="dt">{{ $t("admin.pages.pickingOrders.poNo") }}</div><div class="dd">{{ order.poNo ?? "—" }}</div></div> -->
      <div><div class="dt">{{ $t("admin.pages.pickingOrders.type") }}</div><div class="dd">{{ order.pickingOrderType ?? "—" }}</div></div>
      <div><div class="dt">{{ $t("admin.pages.pickingOrders.remark") }}</div><div class="dd">{{ order.remark ?? "—" }}</div></div>
      <div>
        <div class="dt">{{ $t("admin.pages.pickingOrders.shipTo") }}</div>
        <div class="dd date-edit">
          <SearchableSelect
            v-model="shipToInput"
            :options="countryOptions"
            :all-label="$t('admin.pages.pickingOrders.locationNone')"
            :aria-label="$t('admin.pages.pickingOrders.shipTo')"
            :multiple="false"
            class="ship-to-select"
          />
        </div>
      </div>
      <div>
        <div class="dt">{{ $t("admin.pages.pickingOrders.orgSubInventory") }}</div>
        <div class="dd location-edit">
          <SearchableSelect
            v-model="editOrgId"
            :options="orgOptions"
            :all-label="$t('admin.pages.pickingOrders.locationNone')"
            :aria-label="$t('admin.pages.pickingOrders.locationOrg')"
            :multiple="false"
          />
          <SearchableSelect
            v-model="editSubInventory"
            :options="subInventoryOptions"
            :all-label="$t('admin.pages.pickingOrders.locationNone')"
            :aria-label="$t('admin.pages.pickingOrders.locationSubInventory')"
            :multiple="false"
          />
        </div>
        <div v-if="locationError" class="field-error">{{ locationError }}</div>
      </div>
      <div>
        <div class="dt">{{ $t("admin.pages.pickingOrders.deliveryDate") }}</div>
        <div class="dd date-edit">
          <input v-model="deliveryDate" type="date" />
        </div>
      </div>
    </div>
    <div class="info-actions">
      <span v-if="infoSaved" class="muted">{{ $t("admin.pages.pickingOrders.saved") }}</span>
      <button class="btn btn-primary" :disabled="savingInfo" @click="saveInfo">
        {{ savingInfo ? $t("admin.common.saving") : $t("admin.common.save") }}
      </button>
    </div>

    <template v-if="order.status === 'issue'">
      <h2 class="section-title">{{ $t("admin.pages.pickingOrders.issue") }}</h2>
      <div class="detail-grid">
        <div><div class="dt">{{ $t("admin.pages.pickingOrders.issueReason") }}</div><div class="dd">{{ order.issueReason ?? "—" }}</div></div>
        <div><div class="dt">{{ $t("admin.pages.pickingOrders.issueQty") }}</div><div class="dd">{{ order.issueQty ?? "—" }}</div></div>
        <div><div class="dt">{{ $t("admin.pages.pickingOrders.issuePackSize") }}</div><div class="dd">{{ order.issuePackSize ?? "—" }}</div></div>
        <div><div class="dt">{{ $t("admin.pages.pickingOrders.issueNote") }}</div><div class="dd">{{ order.issueNote ?? "—" }}</div></div>
        <div><div class="dt">{{ $t("admin.pages.pickingOrders.issueRemark") }}</div><div class="dd">{{ order.issueRemark ?? "—" }}</div></div>
        <div><div class="dt">{{ $t("admin.pages.pickingOrders.issueReportedAt") }}</div><div class="dd">{{ order.issueReportedAt ? formatDateTime(order.issueReportedAt) : "—" }}</div></div>
        <div><div class="dt">{{ $t("admin.pages.pickingOrders.issueReportedBy") }}</div><div class="dd">{{ order.issueReportedByName ?? order.issueReportedBy ?? "—" }}</div></div>
        <div>
          <button class="btn btn-small btn-primary" :disabled="resolvingIssue" @click="resolveIssue">
            {{ resolvingIssue ? $t("admin.common.saving") : $t("admin.pages.pickingOrders.resolveIssue") }}
          </button>
        </div>
      </div>
    </template>

    <h2 class="section-title">
      {{ $t("admin.pages.pickingOrders.items") }}
      <span class="view-toggle">
        <button
          type="button"
          class="view-toggle-btn"
          :class="{ active: itemsView === 'flat' }"
          @click="itemsView = 'flat'"
        >
          {{ $t("admin.pages.pickingOrders.itemsViewFlat") }}
        </button>
        <button
          type="button"
          class="view-toggle-btn"
          :class="{ active: itemsView === 'grouped' }"
          @click="itemsView = 'grouped'"
        >
          {{ $t("admin.pages.pickingOrders.itemsViewGrouped") }}
        </button>
      </span>
    </h2>
    <DataTable :table="itemsTable" :on-reset-columns="resetItemsColumns" :row-class="itemsRowClass">
      <template #cell-partNo="{ row }">
        <span class="partno-cell">
          {{ row.wclItemNo ?? row.partNo }}
          <button
            class="icon-btn"
            :title="$t('admin.pages.pickingOrders.searchAvailability')"
            @click.stop="openAvailability(row)"
          >
            🔍
          </button>
        </span>
      </template>
      <template #cell-line="{ row }">
        <template v-if="row.grouped">{{ row.lineLabel }}</template>
        <template v-else>{{ row.lineNumber ?? "—" }} / {{ row.shipmentNumber ?? "—" }}</template>
      </template>
      <template #cell-allocations="{ row }">
        <template v-if="!row.grouped">
          <template v-for="a in row.allocations" :key="a.id">
          <AllocationsStockAllocationRow
            v-if="a.lot"
            :qty="a.qty"
            :removing="!!removingAlloc[a.id]"
            :remove-title="$t('admin.pages.pickingOrders.removeAllocation')"
            @remove="removeAllocation(row, a)"
          >
            {{ allocationSource(a) }}
            <span v-if="a.lot.shelfWarning" class="shelf-warning" :title="a.lot.shelfWarning">⚠️</span>
            <span v-if="a.outdated" class="shelf-warning" :title="$t('stockAgeWarning.tooltip')">⚠️</span>
            <template #tooltip>
              <AllocationsAllocationDetail :a="a" />
            </template>
          </AllocationsStockAllocationRow>
          <AllocationsReceivingAllocationRow
            v-else
            :qty="a.qty"
            :removing="!!removingAlloc[a.id]"
            :remove-title="$t('admin.pages.pickingOrders.removeAllocation')"
            @remove="removeAllocation(row, a)"
          >
            {{ allocationSource(a) }}
            <span v-if="a.outdated" class="shelf-warning" :title="$t('stockAgeWarning.tooltip')">⚠️</span>
            <template v-if="a.receiving" #tooltip>
              <AllocationsAllocationDetail :a="a" />
            </template>
          </AllocationsReceivingAllocationRow>
        </template>
        <span v-if="row.allocations.length === 0" class="muted">—</span>
        </template>
        <template v-else>
          <AllocationsTooltip v-for="a in row.allocations" :key="a.id">
            <div class="alloc-readonly">
              <AllocationsDot :source="a.lot ? 'stock' : 'receiving'" />
              <span>{{ a.qty }} × {{ allocationSource(a) }}</span>
              <span v-if="a.lot?.shelfWarning" class="shelf-warning" :title="a.lot.shelfWarning">⚠️</span>
              <span v-if="a.outdated" class="shelf-warning" :title="$t('stockAgeWarning.tooltip')">⚠️</span>
            </div>
            <template v-if="a.lot || a.receiving" #popup>
              <AllocationsAllocationDetail :a="a" />
            </template>
          </AllocationsTooltip>
          <span v-if="row.allocations.length === 0" class="muted">—</span>
        </template>
      </template>
      <template #cell-packages="{ row }">
        <div v-for="p in row.packages" :key="p.id">
          {{ p.qty }} (dc {{ formatDcLabel(p) || "—"
          }}{{ p.shippingBoxId ? `, ${$t("admin.pages.pickingOrders.boxed")}` : `, ${$t("admin.pages.pickingOrders.unboxed")}`
          }}{{ p.verified ? `, ${$t("admin.pages.pickingOrders.verified")}` : "" }})
        </div>
        <span v-if="row.packages.length === 0" class="muted">—</span>
      </template>
    </DataTable>

    <h2 class="section-title">{{ $t("admin.pages.pickingOrders.shippingBoxes") }}</h2>
    <DataTable
      :table="boxesTable"
      :empty-text="$t('admin.pages.pickingOrders.noBoxes')"
      :on-reset-columns="resetBoxesColumns"
    >
      <template #cell-status="{ row }">
        {{ $t(`status.box.${row.status}`) }}
        <div v-if="row.shippedAt" class="muted">{{ formatDateTime(row.shippedAt) }}</div>
      </template>
      <template #cell-boxSize="{ row }">{{ row.boxSize ?? "—" }}</template>
      <template #cell-netGross="{ row }">{{ row.netWeight ?? "—" }} / {{ row.grossWeight ?? "—" }}</template>
      <template #cell-destinationCountry="{ row }">{{ row.destinationCountry ?? "—" }}</template>
      <template #cell-measuringAssignee="{ row }">
        <SearchableSelect
          :model-value="assigneeValue('measuring', row.id)"
          :options="assigneeOptions"
          :all-label="$t('taskAssignments.unassigned')"
          :aria-label="$t('admin.pages.pickingOrders.measuringAssignee')"
          :multiple="false"
          :disabled="!!assigneeSaving['measuring:' + row.id]"
          @update:model-value="saveStepAssignee('measuring', row.id, $event)"
        />
      </template>
      <template #cell-verifyAssignee="{ row }">
        <SearchableSelect
          v-if="row.verifyTaskId"
          :model-value="assigneeValue('verify', row.verifyTaskId)"
          :options="assigneeOptions"
          :all-label="$t('taskAssignments.unassigned')"
          :aria-label="$t('admin.pages.pickingOrders.verifyAssignee')"
          :multiple="false"
          :disabled="!!assigneeSaving['verify:' + row.verifyTaskId]"
          @update:model-value="saveStepAssignee('verify', row.verifyTaskId, $event)"
        />
        <span v-else class="muted">—</span>
      </template>
    </DataTable>

    <AuditLogTable :fetch-logs="fetchLogs" :refresh-key="logsKey" />

    <div
      v-if="reportOpen"
      class="overlay"
      @mousedown="reportDismiss.onMousedown"
      @click="reportDismiss.onClick"
    >
      <div class="dialog">
        <button type="button" class="dialog-close" @click="reportOpen = false" aria-label="Close">&times;</button>
        <h2>{{ $t("admin.pages.pickingOrders.reportModalTitle", { orderNo: order.orderNo }) }}</h2>
        <div v-if="reportError" class="error-banner">{{ reportError }}</div>
        <form @submit.prevent="submitReport">
          <div class="form-row">
            <label for="pi-reason">{{ $t("admin.pages.pickingOrders.issueReason") }}</label>
            <SearchableSelect
              v-model="reportReason"
              :options="reportReasonOptions"
              :all-label="$t('admin.pages.pickingOrders.reportReasonPlaceholder')"
              :aria-label="$t('admin.pages.pickingOrders.issueReason')"
              :multiple="false"
              :show-all="false"
            />
          </div>
          <div v-if="reportReason === 'insufficient_stock'" class="form-row">
            <label for="pi-qty">{{ $t("admin.pages.pickingOrders.reportQty") }}</label>
            <input id="pi-qty" v-model="reportQtyInput" type="number" min="0" step="1" />
            <div class="hint">{{ $t("admin.pages.pickingOrders.reportQtyHint", { qty: totalQty }) }}</div>
          </div>
          <div v-if="reportReason === 'cannot_divide'" class="form-row">
            <label for="pi-pack">{{ $t("admin.pages.pickingOrders.reportPackSize") }}</label>
            <input id="pi-pack" v-model="reportPackSizeInput" type="number" min="1" step="1" />
          </div>
          <div class="form-row">
            <label for="pi-note">{{ $t("admin.pages.pickingOrders.reportNote") }}</label>
            <input id="pi-note" v-model="reportNote" type="text" />
          </div>
          <div class="form-row">
            <label for="pi-remark">{{ $t("admin.pages.pickingOrders.reportRemark") }}</label>
            <input id="pi-remark" v-model="reportRemark" type="text" />
          </div>
          <div class="dialog-actions">
            <button type="button" class="btn" @click="reportOpen = false">{{ $t("admin.common.cancel") }}</button>
            <button type="submit" class="btn btn-primary" :disabled="reportSubmitting">
              {{ reportSubmitting ? $t("admin.common.saving") : $t("admin.pages.pickingOrders.reportSubmit") }}
            </button>
          </div>
        </form>
      </div>
    </div>
    <PartAvailabilityModal
      :open="availOpen"
      :part-no="availItem?.partNo ?? availGroup?.partNo ?? ''"
      :wcl-item-no="availItem?.wclItemNo ?? availGroup?.wclItemNo ?? null"
      :context-org-id="order.orgId ?? null"
      :context-sub-inventory="order.subInventoryCode ?? null"
      :picking-item-ids="availItemIds"
      :order-no="order.orderNo"
      :picking-order-id="orderId"
      :picking-item="availItem"
      :picking-group="availGroup"
      @close="availOpen = false"
      @allocated="onAllocated"
    />
  </div>
</template>

<style scoped>
:deep(.row-cancelled) {
  text-decoration: line-through;
  color: var(--muted);
  opacity: 0.75;
}

.section-title {
  font-size: 0.9375rem;
  margin: 1.125rem 0 0.5rem;
  color: #52606d;
}
.view-toggle {
  margin-left: 0.625rem;
  display: inline-flex;
}
.view-toggle-btn {
  padding: 0.1875rem 0.625rem;
  font-size: 0.75rem;
  border: 1px solid #b6c2cd;
  background: #fff;
  color: #52606d;
  cursor: pointer;
}
.view-toggle-btn:first-child {
  border-radius: 0.25rem 0 0 0.25rem;
}
.view-toggle-btn:last-child {
  border-radius: 0 0.25rem 0.25rem 0;
  margin-left: -0.0625rem;
}
.view-toggle-btn.active {
  background: #0b5cab;
  border-color: #0b5cab;
  color: #fff;
}
.alloc-readonly {
  display: flex;
  align-items: center;
  gap: 0.375rem;
}
.date-edit {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.date-edit input {
  padding: 0.3125rem 0.4375rem;
  border: 1px solid #b6c2cd;
  border-radius: 0.25rem;
}
.info-actions {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.5rem;
}
.ship-to-select {
  min-width: 13.75rem;
}
.location-edit {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.location-edit > * {
  min-width: 8.75rem;
}
.field-error {
  margin-top: 0.25rem;
  font-size: 0.8125rem;
  color: #b3261e;
}
.alloc-done-banner {
  margin-bottom: 0.75rem;
  padding: 0.5625rem 0.75rem;
  border-radius: 0.375rem;
  font-size: 0.875rem;
  background: #e9f7ef;
  border: 1px solid #b5e2c8;
  color: #1e7a46;
}
.shelf-warning {
  cursor: help;
}
</style>
