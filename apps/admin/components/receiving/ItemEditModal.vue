<script setup lang="ts">
// Edit modal for receiving invoice items (standard + CN receiving). One item
// = single edit (all fields submitted, so blanks clear); multiple items =
// batch edit (only non-blank fields are applied, blanks leave the existing
// values unchanged — tick a field's "Clear" box to batch-clear its value).
// The item type is the structural subset the modal actually reads — both
// ReceivingItemRow and the CN order item satisfy it.
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
  drawingNo?: string | null;
  subInventoryCode?: string | null;
  suggestedShelf?: string | null;
  mismatch?: { reason: string | null; mismatchQty: number | null; wrongPartNo: string | null; note: string | null } | null;
}

const props = defineProps<{
  items: ItemEditTarget[];
  saving: boolean;
  /** When true, the drawing-number field joins the form (standard receiving —
   *  persisted in additional_data.drawing_no). */
  withDrawingNo?: boolean;
  /** When provided, a sub-inventory dropdown joins the form (CN receiving).
   *  Callers without options (standard receiving) get the plain text fields. */
  subInventoryOptions?: { value: string; label: string }[];
  /** Same pattern as subInventoryOptions: a shelf dropdown (CN receiving). */
  shelfOptions?: { value: string; label: string }[];
}>();
const emit = defineEmits<{
  close: [];
  save: [
    fields: Partial<
      Record<"dateCode" | "lotCode" | "coo" | "cow" | "ctnNo" | "drawingNo" | "subInventory" | "suggestedShelf", string | null>
    >,
  ];
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
const drawingNo = ref("");
const subInventory = ref("");
const suggestedShelf = ref("");

// Batch mode: ticked fields are force-cleared (submitted as null) instead of
// the blank-means-unchanged default.
const cleared = ref<Record<string, boolean>>({});

watch(
  () => props.items,
  (items) => {
    const it = items.length === 1 ? items[0] : null;
    dateCode.value = it?.dateCode ?? "";
    lotCode.value = it?.lotCode ?? "";
    coo.value = it?.coo ?? "";
    cow.value = it?.cow ?? "";
    ctnNo.value = it?.ctnNo ?? "";
    drawingNo.value = it?.drawingNo ?? "";
    subInventory.value = it?.subInventoryCode ?? "";
    suggestedShelf.value = it?.suggestedShelf ?? "";
    cleared.value = {};
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
  if (props.withDrawingNo) entries.push(["drawingNo", drawingNo.value]);
  const fields: Record<string, string | null> = {};
  for (const [k, v] of entries) {
    // Batch mode skips blanks (keep unchanged) unless the field's Clear box
    // is ticked; single mode sends null to clear.
    if (batch.value && cleared.value[k]) {
      fields[k] = null;
      continue;
    }
    const trimmed = v.trim();
    if (batch.value && trimmed === "") continue;
    fields[k] = trimmed === "" ? null : trimmed;
  }
  // Sub-inventory / suggested shelf (dropdowns, only rendered when their
  // options are provided): single mode sends the selection — empty clears;
  // batch mode only sends a chosen value (empty = leave unchanged) unless
  // the field's Clear box is ticked.
  if (props.subInventoryOptions) {
    if (batch.value && cleared.value.subInventory) fields.subInventory = null;
    else if (!batch.value) fields.subInventory = subInventory.value === "" ? null : subInventory.value;
    else if (subInventory.value !== "") fields.subInventory = subInventory.value;
  }
  if (props.shelfOptions) {
    if (batch.value && cleared.value.suggestedShelf) fields.suggestedShelf = null;
    else if (!batch.value) fields.suggestedShelf = suggestedShelf.value === "" ? null : suggestedShelf.value;
    else if (suggestedShelf.value !== "") fields.suggestedShelf = suggestedShelf.value;
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
            <input id="ie-dc" v-model="dateCode" type="text" :disabled="batch && cleared.dateCode" />
            <button type="button" class="btn btn-small" :disabled="batch && cleared.dateCode" @click="applyDateCode(0)">
              {{ $t("common.today") }}
            </button>
            <button type="button" class="btn btn-small" :disabled="batch && cleared.dateCode" @click="applyDateCode(1)">
              {{ $t("common.nextWeek") }}
            </button>
            <label v-if="batch" class="clear-check"><input v-model="cleared.dateCode" type="checkbox" /> {{ $t("admin.pages.receiving.clearField") }}</label>
          </div>
        </div>
        <div class="form-row">
          <label for="ie-lot">{{ $t("admin.pages.receiving.lotCode") }}</label>
          <div class="field-row">
            <input id="ie-lot" v-model="lotCode" type="text" :disabled="batch && cleared.lotCode" />
            <label v-if="batch" class="clear-check"><input v-model="cleared.lotCode" type="checkbox" /> {{ $t("admin.pages.receiving.clearField") }}</label>
          </div>
        </div>
        <div class="form-row">
          <label for="ie-coo">{{ $t("admin.pages.receiving.coo") }}</label>
          <div class="field-row">
            <input id="ie-coo" v-model="coo" type="text" :disabled="batch && cleared.coo" />
            <label v-if="batch" class="clear-check"><input v-model="cleared.coo" type="checkbox" /> {{ $t("admin.pages.receiving.clearField") }}</label>
          </div>
        </div>
        <div class="form-row">
          <label for="ie-cow">{{ $t("admin.pages.receiving.cow") }}</label>
          <div class="field-row">
            <input id="ie-cow" v-model="cow" type="text" :disabled="batch && cleared.cow" />
            <label v-if="batch" class="clear-check"><input v-model="cleared.cow" type="checkbox" /> {{ $t("admin.pages.receiving.clearField") }}</label>
          </div>
        </div>
        <div class="form-row">
          <label for="ie-ctn">{{ $t("admin.pages.receiving.ctnNo") }}</label>
          <div class="field-row">
            <input id="ie-ctn" v-model="ctnNo" type="text" :disabled="batch && cleared.ctnNo" />
            <label v-if="batch" class="clear-check"><input v-model="cleared.ctnNo" type="checkbox" /> {{ $t("admin.pages.receiving.clearField") }}</label>
          </div>
        </div>
        <div v-if="withDrawingNo" class="form-row">
          <label for="ie-draw">{{ $t("admin.pages.receiving.drawingNo") }}</label>
          <div class="field-row">
            <input id="ie-draw" v-model="drawingNo" type="text" :disabled="batch && cleared.drawingNo" />
            <label v-if="batch" class="clear-check"><input v-model="cleared.drawingNo" type="checkbox" /> {{ $t("admin.pages.receiving.clearField") }}</label>
          </div>
        </div>
        <div v-if="subInventoryOptions" class="form-row">
          <label>{{ $t("admin.pages.receivingCn.itemsTable.subInventory") }}</label>
          <div class="field-row">
            <SearchableSelect
              v-model="subInventory"
              :options="subInventoryOptions"
              :all-label="$t('admin.pages.receivingCn.itemsTable.subInventory')"
              :aria-label="$t('admin.pages.receivingCn.itemsTable.subInventory')"
              :multiple="false"
              :show-all="false"
              :disabled="batch && cleared.subInventory"
            />
            <label v-if="batch" class="clear-check"><input v-model="cleared.subInventory" type="checkbox" /> {{ $t("admin.pages.receiving.clearField") }}</label>
          </div>
        </div>
        <div v-if="shelfOptions" class="form-row">
          <label>{{ $t("admin.pages.receivingCn.itemsTable.suggestedShelf") }}</label>
          <div class="field-row">
            <SearchableSelect
              v-model="suggestedShelf"
              :options="shelfOptions"
              :all-label="$t('admin.pages.receivingCn.itemsTable.suggestedShelf')"
              :aria-label="$t('admin.pages.receivingCn.itemsTable.suggestedShelf')"
              :multiple="false"
              :show-all="false"
              :disabled="batch && cleared.suggestedShelf"
            />
            <label v-if="batch" class="clear-check"><input v-model="cleared.suggestedShelf" type="checkbox" /> {{ $t("admin.pages.receiving.clearField") }}</label>
          </div>
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
.dc-row,
.field-row {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}
.dc-row input,
.field-row input,
.field-row :deep(.ssel) {
  flex: 1;
}
.clear-check {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  font-size: 0.8125rem;
  white-space: nowrap;
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
