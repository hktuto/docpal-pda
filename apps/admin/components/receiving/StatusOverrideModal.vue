<script setup lang="ts">
import type { SearchableSelectOption } from "~/components/SearchableSelect.vue";

// "Override status" modal — shared by the receiving order detail page (one
// order) and the receiving order list batch action (many). Dumb dialog: emits
// `apply` with the chosen status + reason; the parent performs the API call(s)
// and closes the modal on success. Warns when the override would reopen a
// clear order (it re-enters allocation supply) or roll an in-hand/clear order
// back to pre-receipt (received quantities are kept).
const props = defineProps<{
  open: boolean;
  /** Order display names — one for the detail page, many for the batch action. */
  orderNos: string[];
  /** Current statuses of the affected orders (drives the warnings). */
  currentStatuses: string[];
}>();

const emit = defineEmits<{
  close: [];
  apply: [{ status: string; reason: string }];
}>();

const { t } = useI18n();

const STATUSES = ["pending", "provisional_received", "in_hand", "clear"];

const statusOptions = computed<SearchableSelectOption[]>(() =>
  STATUSES.map((s) => ({ value: s, label: t(`status.receiving.${s}`) }))
);

const status = ref("");
const reason = ref("");
const dismiss = useOverlayDismiss(() => emit("close"));

// Reopen = any affected order currently clear moving back to non-clear —
// its stock re-enters allocation supply.
const reopenWarning = computed(
  () => status.value !== "" && status.value !== "clear" && props.currentStatuses.some((s) => s === "clear")
);

// Backward = an in-hand/clear order rolled back to pre-receipt — received
// quantities and dock ledger rows are kept as-is.
const backwardWarning = computed(
  () =>
    (status.value === "pending" || status.value === "provisional_received") &&
    props.currentStatuses.some((s) => s === "in_hand" || s === "clear")
);

watch(
  () => props.open,
  (open) => {
    if (open) {
      status.value = "";
      reason.value = "";
    }
  }
);

function apply() {
  if (!status.value) return;
  emit("apply", { status: status.value, reason: reason.value.trim() });
}
</script>

<template>
  <div v-if="open" class="overlay" @mousedown="dismiss.onMousedown" @click="dismiss.onClick">
    <div class="dialog status-dialog">
      <h2>
        {{
          orderNos.length === 1
            ? $t("admin.pages.receiving.overrideModalTitleSingle", { orderNo: orderNos[0] })
            : $t("admin.pages.receiving.overrideModalTitleBatch", { n: orderNos.length })
        }}
      </h2>
      <div class="override-form">
        <label class="override-field">
          <span>{{ $t("admin.pages.receiving.overrideTarget") }}</span>
          <SearchableSelect
            v-model="status"
            :options="statusOptions"
            :all-label="$t('admin.pages.receiving.overrideTargetPlaceholder')"
            :aria-label="$t('admin.pages.receiving.overrideTarget')"
            :multiple="false"
          />
        </label>
        <label class="override-field">
          <span>{{ $t("admin.pages.receiving.overrideReason") }}</span>
          <input v-model="reason" :placeholder="$t('admin.pages.receiving.overrideReasonPlaceholder')" />
        </label>
        <div v-if="reopenWarning" class="override-warning">
          {{ $t("admin.pages.receiving.overrideReopenWarning") }}
        </div>
        <div v-if="backwardWarning" class="override-warning">
          {{ $t("admin.pages.receiving.overrideBackwardWarning") }}
        </div>
      </div>
      <div class="dialog-actions">
        <button class="btn" @click="emit('close')">{{ $t("admin.common.cancel") }}</button>
        <button class="btn btn-primary" :disabled="!status" @click="apply">
          {{ $t("admin.common.save") }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.status-dialog {
  width: 30rem;
}
.override-form {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  margin: 0.875rem 0;
}
.override-field {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  font-size: 0.875rem;
}
.override-warning {
  padding: 0.5625rem 0.75rem;
  border-radius: 0.375rem;
  font-size: 0.8125rem;
  background: #fdf3e7;
  border: 1px solid #f0c48c;
  color: #9a5b00;
}
</style>
