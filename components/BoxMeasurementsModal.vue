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
        <form class="form" @submit.prevent="onSave">
          <label class="field">
            <span>{{ $t('boxMeasurementsModal.boxSize') }} <span class="required">{{ $t('boxMeasurementsModal.required') }}</span></span>
            <select v-model="form.boxSize" :disabled="isBusy">
              <option value="">{{ $t('boxMeasurementsModal.placeholderBoxSize') }}</option>
              <option v-for="size in boxSizeOptions" :key="size" :value="size">{{ size }}</option>
            </select>
          </label>

          <label class="field">
            <span>{{ $t('boxMeasurementsModal.netWeight') }} <span class="required">{{ $t('boxMeasurementsModal.required') }}</span></span>
            <input v-model="form.netWeight" type="number" step="0.01" :placeholder="$t('boxMeasurementsModal.placeholderNetWeight')" :disabled="isBusy" />
          </label>

          <label class="field">
            <span>{{ $t('boxMeasurementsModal.grossWeight') }} <span class="required">{{ $t('boxMeasurementsModal.required') }}</span></span>
            <input v-model="form.grossWeight" type="number" step="0.01" :placeholder="$t('boxMeasurementsModal.placeholderGrossWeight')" :disabled="isBusy" />
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
            <button type="submit" class="btn btn--small" :disabled="isBusy || !isValid">
              {{ saving ? $t('boxMeasurementsModal.saving') : $t('boxMeasurementsModal.saveBoxDetails') }}
            </button>
            <button type="button" class="btn" :disabled="isBusy || !isValid" @click="onFinish">
              {{ finishing ? $t('boxMeasurementsModal.finishing') : $t('boxMeasurementsModal.finishBox') }}
            </button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { I18nError } from "~/composables/i18nError";
import { updateShippingBox, closeShippingBox } from "~/db/measuring";
import { boxSizeOptions, countryOptions } from "~/constants/pocOptions";

const { t } = useI18n();
const getErrorMessage = useErrorMessage();

const countryLabels = computed(() => t('countryLabels') as Record<string, string>);
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
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: boolean): void;
  (e: "saved"): void;
  (e: "finished"): void;
}>();

const db = await useDb();
const { currentUser } = useAuth();

const defaultForm: MeasurementForm = {
  boxSize: "",
  netWeight: "",
  grossWeight: "",
  destinationCountry: "",
};

const form = ref<MeasurementForm>({ ...defaultForm });
const saving = ref(false);
const finishing = ref(false);
const errorText = ref<string | null>(null);

const isBusy = computed(() => saving.value || finishing.value);

const isValid = computed(() => {
  if (!form.value.boxSize) return false;
  if (!form.value.destinationCountry) return false;
  const net = Number(form.value.netWeight);
  const gross = Number(form.value.grossWeight);
  if (Number.isNaN(net) || net <= 0) return false;
  if (Number.isNaN(gross) || gross <= 0) return false;
  if (gross < net) return false;
  return true;
});

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      errorText.value = null;
      form.value = {
        boxSize: props.initialValues?.boxSize ?? "",
        netWeight: props.initialValues?.netWeight ?? "",
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

function close() {
  emit("update:modelValue", false);
}

async function persist() {
  await updateShippingBox(db, props.boxId, {
    boxSize: form.value.boxSize,
    netWeight: form.value.netWeight,
    grossWeight: form.value.grossWeight,
    destinationCountry: form.value.destinationCountry,
  });
}

async function onSave() {
  if (!isValid.value) return;
  saving.value = true;
  errorText.value = null;
  try {
    await persist();
    emit("saved");
  } catch (e: any) {
    errorText.value = getErrorMessage(e);
  } finally {
    saving.value = false;
  }
}

async function onFinish() {
  if (!isValid.value) return;
  finishing.value = true;
  errorText.value = null;
  try {
    if (!currentUser.value) throw new I18nError("no_operator_user_found");
    await persist();
    await closeShippingBox(db, props.boxId, currentUser.value.id);
    emit("finished");
    close();
  } catch (e: any) {
    errorText.value = getErrorMessage(e);
  } finally {
    finishing.value = false;
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

.required {
  color: var(--danger);
}
</style>
