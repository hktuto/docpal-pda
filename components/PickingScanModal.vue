<template>
  <div
    v-if="modelValue"
    class="modal-overlay"
    role="dialog"
    aria-modal="true"
    aria-labelledby="scan-title"
    @click.self="!isBusy && close()"
    @keydown.esc="!isBusy && close()"
  >
    <div class="modal">
      <div class="modal__header">
        <h3 id="scan-title">Scan package</h3>
        <button class="modal__close" aria-label="Close" :disabled="isBusy" @click="close">×</button>
      </div>

      <div class="modal__body">
        <template v-if="status === 'idle' || status === 'scanning'">
          <p class="subtitle">Enter scan details for this allocation.</p>

          <form class="form" @submit.prevent="onScanClick">
            <label class="field">
              <span>Part No.</span>
              <input :value="partNo" type="text" disabled />
            </label>

            <label class="field">
              <span>Qty <span class="required">*</span></span>
              <input v-model.number="form.qty" type="number" min="1" :max="allocation.qty" placeholder="e.g. 400" />
            </label>

            <template v-if="isReceivingAllocation">
              <label class="field">
                <span>Date Code</span>
                <input v-model="form.dateCode" type="text" placeholder="e.g. 2406" />
              </label>
              <label class="field">
                <span>Lot Code</span>
                <input v-model="form.lotCode" type="text" placeholder="e.g. L240603" />
              </label>
              <label class="field">
                <span>COO</span>
                <input v-model="form.coo" type="text" placeholder="e.g. MY" />
              </label>
              <label class="field">
                <span>COW</span>
                <input v-model="form.cow" type="text" placeholder="e.g. USA" />
              </label>
            </template>

            <template v-else-if="lot">
              <div class="read-only-field">
                <span>Date / Lot / COO / COW</span>
                <span>
                  {{ lot.dateCode || "—" }} /
                  {{ lot.lotCode || "—" }} /
                  {{ lot.coo || "—" }} /
                  {{ lot.cow || "—" }}
                </span>
              </div>
            </template>

            <p v-if="errorMessage" class="error">{{ errorMessage }}</p>

            <button
              type="submit"
              class="btn"
              style="width: 100%; margin-top: 1rem;"
              :disabled="scanning"
            >
              {{ scanning ? "Scanning…" : "Scan" }}
            </button>
          </form>
        </template>

        <template v-else-if="status === 'success'">
          <div class="card" style="border-left: 4px solid #16a34a;">
            <p><strong>Package scanned</strong></p>
            <p class="subtitle">{{ form.qty }} pcs scanned</p>
          </div>
          <div style="display: flex; gap: 0.5rem; margin-top: 1rem;">
            <button class="btn" style="flex: 1;" @click="resetState">Scan again</button>
            <button class="btn" style="flex: 1;" @click="close">Finish</button>
          </div>
        </template>

        <template v-else-if="status === 'error'">
          <div class="card" style="border-left: 4px solid #dc2626;">
            <p><strong>Error</strong></p>
            <p class="subtitle">{{ errorMessage }}</p>
          </div>
          <button class="btn" style="width: 100%; margin-top: 1rem;" @click="resetState">Try again</button>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { materializeReceivingAllocation, scanAllocationToPackage } from "~/db/picking";

const props = defineProps<{
  modelValue: boolean;
  allocation: any;
  item: any;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: boolean): void;
  (e: "applied"): void;
}>();

const db = await useDb();
const currentUser = await useCurrentUser();

interface ScanForm {
  qty: number;
  dateCode: string;
  lotCode: string;
  coo: string;
  cow: string;
}

const form = ref<ScanForm>({
  qty: 1,
  dateCode: "",
  lotCode: "",
  coo: "",
  cow: "",
});

const status = ref<"idle" | "scanning" | "success" | "error">("idle");
const errorMessage = ref<string | null>(null);
const scanning = ref(false);

const isBusy = computed(() => scanning.value || status.value === "scanning");

const lot = computed(() => props.allocation?.inventoryLot ?? null);
const isReceivingAllocation = computed(() => !!props.allocation?.receivingInvoiceItem);
const partNo = computed(() => props.item?.part?.partNo || props.allocation?.inventoryLot?.part?.partNo || "—");

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      resetState();
    }
  }
);

function resetState() {
  status.value = "idle";
  errorMessage.value = null;
  scanning.value = false;
  form.value = {
    qty: props.allocation?.qty ?? 1,
    dateCode: "",
    lotCode: "",
    coo: "",
    cow: "",
  };
}

function close() {
  emit("update:modelValue", false);
}

async function onScanClick() {
  errorMessage.value = null;

  if (!currentUser?.id) {
    errorMessage.value = "Operator not signed in";
    return;
  }
  if (!form.value.qty || form.value.qty <= 0) {
    errorMessage.value = "Qty must be greater than zero";
    return;
  }
  if (form.value.qty > props.allocation.qty) {
    errorMessage.value = "Qty exceeds allocated quantity";
    return;
  }

  scanning.value = true;
  status.value = "scanning";

  try {
    if (isReceivingAllocation.value) {
      const materializedId = await materializeReceivingAllocation(
        db,
        props.allocation.id,
        form.value.qty,
        form.value.dateCode || null,
        form.value.lotCode || null,
        form.value.coo || null,
        form.value.cow || null
      );
      await scanAllocationToPackage(db, materializedId, form.value.qty, currentUser.id);
    } else {
      await scanAllocationToPackage(db, props.allocation.id, form.value.qty, currentUser.id);
    }

    status.value = "success";
    emit("applied");
  } catch (e: any) {
    status.value = "error";
    errorMessage.value = e?.message ?? String(e);
  } finally {
    scanning.value = false;
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

.subtitle {
  color: var(--muted);
  font-size: 0.875rem;
  margin: 0 0 1rem;
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

.field span,
.read-only-field span {
  color: var(--muted);
}

.field input {
  padding: 0.5rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  color: var(--text);
  font-size: 0.9375rem;
}

.field input:disabled {
  opacity: 0.6;
}

.read-only-field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.875rem;
  padding: 0.5rem;
  background: var(--bg);
  border-radius: var(--radius);
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
