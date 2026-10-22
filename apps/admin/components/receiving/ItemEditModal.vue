<script setup lang="ts">
// Edit modal for receiving invoice items (standard + CN receiving). One item
// = single edit (all fields submitted, so blanks clear); multiple items =
// batch edit (only non-blank fields are applied, blanks leave the existing
// values unchanged). The item type is the structural subset the modal
// actually reads — both ReceivingItemRow and the CN order item satisfy it.
export interface ItemEditTarget {
  id: string;
  partNo: string;
  wclItemNo: string | null;
  poNo: string | null;
  poLine: string | null;
  lineQty: number | null;
  receivedQty: number;
  dateCode?: string | null;
  lotCode?: string | null;
  coo?: string | null;
  cow?: string | null;
  ctnNo?: string | null;
  subInventoryCode?: string | null;
  mismatch?: { reason: string | null; mismatchQty: number | null; wrongPartNo: string | null; note: string | null } | null;
}

const props = defineProps<{
  items: ItemEditTarget[];
  saving: boolean;
  /** When provided, a sub-inventory dropdown joins the form (CN receiving).
   *  Callers without options (standard receiving) get the plain text fields. */
  subInventoryOptions?: { value: string; label: string }[];
}>();
const emit = defineEmits<{
  close: [];
  save: [fields: Partial<Record<"dateCode" | "lotCode" | "coo" | "cow" | "ctnNo" | "subInventory", string | null>>];
}>();

const { t } = useI18n();
const dismiss = useOverlayDismiss(() => emit("close"));

const batch = computed(() => props.items.length > 1);
const single = computed(() => (batch.value ? null : props.items[0] ?? null));

const dateCode = ref("");
const lotCode = ref("");
const coo = ref("");
const cow = ref("");
const ctnNo = ref("");
const subInventory = ref("");

watch(
  () => props.items,
  (items) => {
    const it = items.length === 1 ? items[0] : null;
    dateCode.value = it?.dateCode ?? "";
    lotCode.value = it?.lotCode ?? "";
    coo.value = it?.coo ?? "";
    cow.value = it?.cow ?? "";
    ctnNo.value = it?.ctnNo ?? "";
    subInventory.value = it?.subInventoryCode ?? "";
  },
  { immediate: true }
);

function submit() {
  const entries: [string, string][] = [
    ["dateCode", dateCode.value],
    ["lotCode", lotCode.value],
    ["coo", coo.value],
    ["cow", cow.value],
    ["ctnNo", ctnNo.value],
  ];
  const fields: Record<string, string | null> = {};
  for (const [k, v] of entries) {
    const trimmed = v.trim();
    // Batch mode skips blanks (keep unchanged); single mode sends null to clear.
    if (batch.value && trimmed === "") continue;
    fields[k] = trimmed === "" ? null : trimmed;
  }
  // Sub-inventory (dropdown, only rendered when options are provided): single
  // mode sends the selection — empty clears; batch mode only sends a chosen
  // value (empty = leave unchanged).
  if (props.subInventoryOptions) {
    if (!batch.value) fields.subInventory = subInventory.value === "" ? null : subInventory.value;
    else if (subInventory.value !== "") fields.subInventory = subInventory.value;
  }
  emit("save", fields);
}

// WWYY date code (ISO-8601 week number + 2-digit year), offset in weeks from today.
function applyDateCode(offsetWeeks: number) {
  const nowDate = new Date();
  const d = new Date(Date.UTC(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() + offsetWeeks * 7));
  const dayNum = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - dayNum + 3); // Thursday of this ISO week
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / 604800000);
  dateCode.value = `${String(week).padStart(2, "0")}${String(d.getUTCFullYear()).slice(2)}`;
}
</script>

<template>
  <div class="overlay" @mousedown="dismiss.onMousedown" @click="dismiss.onClick">
    <div class="dialog">
      <button type="button" class="dialog-close" @click="emit('close')" aria-label="Close">&times;</button>
      <h2 v-if="single">{{ $t("admin.pages.receiving.editModalTitleSingle", { partNo: single.wclItemNo ?? single.partNo }) }}</h2>
      <h2 v-else>{{ $t("admin.pages.receiving.editModalTitleBatch", { count: items.length }) }}</h2>

      <div v-if="single" class="summary">
        <div><span class="dt">{{ $t("admin.pages.receiving.poLine") }}:</span> {{ single.poNo ?? "—" }}<span v-if="single.poLine"> / {{ single.poLine }}</span></div>
        <div><span class="dt">{{ $t("admin.pages.receiving.expected") }}:</span> {{ single.lineQty ?? "—" }} · <span class="dt">{{ $t("admin.pages.receiving.received") }}:</span> {{ single.receivedQty }}</div>
        <div v-if="single.mismatch" class="mismatch-line">
          {{ $t("admin.pages.receiving.mismatch") }}: {{ single.mismatch.reason ?? "—"
          }}<template v-if="single.mismatch.mismatchQty != null"> × {{ single.mismatch.mismatchQty }}</template>
        </div>
      </div>
      <div v-else class="summary">
        <div class="batch-parts">{{ items.map((i) => i.wclItemNo ?? i.partNo).join(", ") }}</div>
        <div class="hint">{{ $t("admin.pages.receiving.leaveUnchangedHint") }}</div>
      </div>

      <form @submit.prevent="submit">
        <div class="form-row">
          <label for="ie-dc">{{ $t("admin.pages.receiving.dateCode") }}</label>
          <div class="dc-row">
            <input id="ie-dc" v-model="dateCode" type="text" />
            <button type="button" class="btn btn-small" @click="applyDateCode(0)">
              {{ $t("common.today") }}
            </button>
            <button type="button" class="btn btn-small" @click="applyDateCode(1)">
              {{ $t("common.nextWeek") }}
            </button>
          </div>
        </div>
        <div class="form-row">
          <label for="ie-lot">{{ $t("admin.pages.receiving.lotCode") }}</label>
          <input id="ie-lot" v-model="lotCode" type="text" />
        </div>
        <div class="form-row">
          <label for="ie-coo">{{ $t("admin.pages.receiving.coo") }}</label>
          <input id="ie-coo" v-model="coo" type="text" />
        </div>
        <div class="form-row">
          <label for="ie-cow">{{ $t("admin.pages.receiving.cow") }}</label>
          <input id="ie-cow" v-model="cow" type="text" />
        </div>
        <div class="form-row">
          <label for="ie-ctn">{{ $t("admin.pages.receiving.ctnNo") }}</label>
          <input id="ie-ctn" v-model="ctnNo" type="text" />
        </div>
        <div v-if="subInventoryOptions" class="form-row">
          <label for="ie-subinv">{{ $t("admin.pages.receivingCn.itemsTable.subInventory") }}</label>
          <SearchableSelect
            v-model="subInventory"
            :options="subInventoryOptions"
            :all-label="$t('admin.pages.receivingCn.itemsTable.subInventory')"
            :aria-label="$t('admin.pages.receivingCn.itemsTable.subInventory')"
            :multiple="false"
            :show-all="false"
          />
        </div>
        <div class="dialog-actions">
          <button type="button" class="btn" @click="emit('close')">{{ $t("admin.common.cancel") }}</button>
          <button type="submit" class="btn btn-primary" :disabled="saving">
            {{ saving ? $t("admin.common.saving") : $t("admin.common.save") }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>

<style scoped>
.dc-row {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}
.dc-row input {
  flex: 1;
}
.summary {
  font-size: 0.8125rem;
  color: #52606d;
  margin-bottom: 0.625rem;
  display: grid;
  gap: 0.25rem;
}
.summary .dt {
  font-weight: 600;
}
.mismatch-line {
  color: #b91c1c;
}
.batch-parts {
  max-height: 5rem;
  overflow-y: auto;
  overflow-wrap: anywhere;
}
</style>
