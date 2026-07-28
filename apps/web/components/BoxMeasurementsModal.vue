<template>
  <div
    v-if="modelValue"
    class="modal-overlay"
    role="dialog"
    aria-modal="true"
    aria-labelledby="measure-title"
    @click.self="!isBusy && close()"
    @keydown.esc="!isBusy && close()"
  >
    <div class="modal">
      <div class="modal__header">
        <h3 id="measure-title">{{ $t('boxMeasurementsModal.title') }}</h3>
        <button class="modal__close" :aria-label="$t('boxMeasurementsModal.close')" :disabled="isBusy" @click="close">×</button>
      </div>

      <div class="modal__body">
        <form class="form" @submit.prevent="onConfirm">
          <label class="field">
            <span>{{ $t('boxMeasurementsModal.boxSize') }} <span class="required">{{ $t('boxMeasurementsModal.required') }}</span></span>
            <select v-model="form.boxSize" :disabled="isBusy">
              <option value="">{{ $t('boxMeasurementsModal.placeholderBoxSize') }}</option>
              <option v-for="size in boxSizeOptions" :key="size" :value="size">{{ size }}</option>
            </select>
          </label>

          <label class="field">
            <span>{{ $t('boxMeasurementsModal.netWeight') }} <span class="required">{{ $t('boxMeasurementsModal.required') }}</span></span>
            <input v-model="form.netWeight" type="number" step="0.001" min="0" inputmode="decimal" :placeholder="$t('boxMeasurementsModal.placeholderNetWeight')" :disabled="isBusy" />
            <span v-if="netWeightAutoFilled" class="auto-hint">{{ $t('boxMeasurementsModal.netWeightAutoHint') }}</span>
          </label>

          <label class="field">
            <span>{{ $t('boxMeasurementsModal.grossWeight') }} <span class="required">{{ $t('boxMeasurementsModal.required') }}</span></span>
            <input v-model="form.grossWeight" type="number" step="0.001" min="0" inputmode="decimal" :placeholder="$t('boxMeasurementsModal.placeholderGrossWeight')" :disabled="isBusy" />
          </label>

          <label class="field">
            <span>{{ $t('boxMeasurementsModal.destinationCountry') }} <span class="required">{{ $t('boxMeasurementsModal.required') }}</span></span>
            <select v-model="form.destinationCountry" :disabled="isBusy">
              <option value="">{{ $t('boxMeasurementsModal.placeholderCountry') }}</option>
              <option v-for="country in countryOptions" :key="country" :value="country">{{ countryName(country) }}</option>
            </select>
          </label>

          <p v-if="errorText" class="error">{{ errorText }}</p>

          <div style="display: flex; gap: 0.5rem; flex-wrap: wrap; margin-top: 0.5rem;">
            <button type="submit" class="btn" :disabled="isBusy || !isValid">
              {{ confirming ? $t('boxMeasurementsModal.confirming') : $t('boxMeasurementsModal.confirmBox') }}
            </button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useWarehouse } from "~/composables/useWarehouse";
import { boxSizeOptions, countryOptions } from "~/constants/pocOptions";

const { t } = useI18n();
const getErrorMessage = useErrorMessage();
const warehouse = useWarehouse();

const countryLabels = computed(() => t('countryLabels') as unknown as Record<string, string>);
function countryName(value: string) {
  return countryLabels.value[value] ?? value;
}

interface MeasurementForm {
  boxSize: string;
  netWeight: string;
  grossWeight: string;
  destinationCountry: string;
}

const props = defineProps<{
  modelValue: boolean;
  boxId: string;
  initialValues?: Partial<MeasurementForm>;
  defaultDestinationCountry?: string | null;
  /** Auto-calculated net weight (kg) from the net-weight formula master — pre-fills the net field when empty. */
  suggestedNetWeightKg?: number | null;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: boolean): void;
  (e: "finished"): void;
}>();

const defaultForm: MeasurementForm = {
  boxSize: "",
  netWeight: "",
  grossWeight: "",
  destinationCountry: "",
};

const form = ref<MeasurementForm>({ ...defaultForm });
const confirming = ref(false);
const errorText = ref<string | null>(null);
// True while the net value shown is the untouched auto-calc pre-fill.
const netWeightAutoFilled = ref(false);

const isBusy = computed(() => confirming.value);

const isValid = computed(() => {
  if (!form.value.boxSize) return false;
  if (!form.value.destinationCountry) return false;
  // Backend weights are kilograms; decimals allowed, closing requires > 0.
  const net = Number(form.value.netWeight);
  const gross = Number(form.value.grossWeight);
  if (!Number.isFinite(net) || net <= 0) return false;
  if (!Number.isFinite(gross) || gross <= 0) return false;
  if (gross < net) return false;
  return true;
});

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      errorText.value = null;
      const initialNet = props.initialValues?.netWeight ?? "";
      netWeightAutoFilled.value = !initialNet && props.suggestedNetWeightKg != null;
      form.value = {
        boxSize: props.initialValues?.boxSize ?? "",
        netWeight:
          initialNet ||
          (props.suggestedNetWeightKg != null ? props.suggestedNetWeightKg.toString() : ""),
        grossWeight: props.initialValues?.grossWeight ?? "",
        destinationCountry:
          props.initialValues?.destinationCountry ??
          props.defaultDestinationCountry ??
          "",
      };
    }
  },
  { immediate: true }
);

watch(
  () => form.value.netWeight,
  (value) => {
    if (netWeightAutoFilled.value && value !== props.suggestedNetWeightKg?.toString()) {
      netWeightAutoFilled.value = false;
    }
  }
);

function close() {
  emit("update:modelValue", false);
}

// One action: persist the kg measurements, then confirm (close) the box.
// Closing the last open box auto-completes the measuring task server-side.
async function onConfirm() {
  if (!isValid.value) return;
  confirming.value = true;
  errorText.value = null;
  try {
    await warehouse.updateShippingBox(props.boxId, {
      boxSize: form.value.boxSize,
      netWeightKg: Number(form.value.netWeight),
      grossWeightKg: Number(form.value.grossWeight),
      destinationCountry: form.value.destinationCountry,
    });
    await warehouse.closeShippingBox(props.boxId);
    emit("finished");
    close();
  } catch (e: any) {
    errorText.value = getErrorMessage(e);
  } finally {
    confirming.value = false;
  }
}
</script>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  z-index: 100;
}

.modal {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  width: 100%;
  max-width: 420px;
  max-height: 90vh;
  overflow-y: auto;
}

.modal__header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1rem;
  border-bottom: 1px solid var(--border);
}

.modal__header h3 {
  margin: 0;
}

.modal__close {
  background: transparent;
  border: none;
  font-size: 1.5rem;
  line-height: 1;
  cursor: pointer;
  color: var(--muted);
}

.modal__body {
  padding: 1rem;
}

.form {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.875rem;
}

.field span {
  color: var(--muted);
}

.field input,
.field select {
  padding: 0.5rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  color: var(--text);
  font-size: 0.9375rem;
}

.error {
  color: var(--danger);
  font-size: 0.875rem;
  margin: 0.75rem 0 0;
}

.auto-hint {
  color: var(--muted);
  font-size: 0.75rem;
}

.required {
  color: var(--danger);
}
</style>
