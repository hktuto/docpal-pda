<template>
  <div v-if="modelValue" class="modal-overlay" @click.self="close">
    <div class="modal">
      <div class="modal__header">
        <h3>Scan label</h3>
        <button class="modal__close" aria-label="Close" @click="close">×</button>
      </div>

      <div class="modal__body">
        <template v-if="matchResult.status === 'idle' || matchResult.status === 'scanning'">
          <p class="subtitle">Enter label details to simulate an OCR scan.</p>

          <div class="form">
            <label class="field">
              <span>Part No. <span class="required">*</span></span>
              <input v-model="form.partNo" type="text" placeholder="e.g. IC-LM358DR" />
            </label>
            <label class="field">
              <span>Date Code</span>
              <input v-model="form.dateCode" type="text" placeholder="e.g. 2406" />
            </label>
            <label class="field">
              <span>Lot Code</span>
              <input v-model="form.lotCode" type="text" placeholder="e.g. L240603" />
            </label>
            <label class="field">
              <span>Origin Country</span>
              <input v-model="form.originCountry" type="text" placeholder="e.g. MY" />
            </label>
            <label class="field">
              <span>Qty <span class="required">*</span></span>
              <input v-model.number="form.qty" type="number" min="1" placeholder="e.g. 400" />
            </label>
          </div>

          <p v-if="parseError" class="error">{{ parseError }}</p>

          <button
            class="btn"
            style="width: 100%; margin-top: 1rem;"
            :disabled="scanning"
            @click="onScanClick"
          >
            {{ scanning ? "Scanning…" : "Scan" }}
          </button>
        </template>

        <template v-else-if="matchResult.status === 'single'">
          <div class="card" style="border-left: 4px solid #16a34a;">
            <p><strong>{{ matchResult.picking.pickingOrderRefNo }}</strong></p>
            <p class="subtitle">Match found — applying pick…</p>
          </div>
        </template>

        <template v-else-if="matchResult.status === 'multiple'">
          <p class="subtitle">Multiple orders need this item. Choose one.</p>
          <div class="options">
            <div
              v-for="candidate in matchResult.picking"
              :key="candidate.pickingItemId"
              class="option"
              @click="onCandidateClick(candidate)"
            >
              <div class="letter">📦</div>
              <div class="content">
                <h3>{{ candidate.pickingOrderRefNo }}</h3>
                <p>Ship to: {{ candidate.shipTo || "—" }} · still needs {{ candidate.remainingQty }}</p>
              </div>
            </div>
          </div>
        </template>

        <template v-else-if="matchResult.status === 'no_match'">
          <div class="card" style="border-left: 4px solid #dc2626;">
            <p><strong>No match</strong></p>
            <p class="subtitle">{{ matchResult.reason }}</p>
          </div>
          <button class="btn" style="width: 100%; margin-top: 1rem;" @click="resetState">Try again</button>
        </template>

        <template v-else-if="matchResult.status === 'applying'">
          <p class="empty">Applying pick…</p>
        </template>

        <template v-else-if="matchResult.status === 'success'">
          <div class="card" style="border-left: 4px solid #16a34a;">
            <p><strong>Pick applied</strong></p>
            <p class="subtitle">{{ matchResult.qty }} pcs added to {{ matchResult.pickingOrderRefNo }}</p>
          </div>
          <button class="btn" style="width: 100%; margin-top: 1rem;" @click="close">Done</button>
        </template>

        <template v-else-if="matchResult.status === 'error'">
          <div class="card" style="border-left: 4px solid #dc2626;">
            <p><strong>Error</strong></p>
            <p class="subtitle">{{ matchResult.message }}</p>
          </div>
          <button class="btn" style="width: 100%; margin-top: 1rem;" @click="resetState">Try again</button>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { OcrInput } from "~/composables/useMockOcr";
import type { PickingCandidate } from "~/db/ocrPicking";

const props = defineProps<{
  modelValue: boolean;
  receivingOrderId: string;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: boolean): void;
  (e: "applied"): void;
}>();

const db = await useDb();
const currentUser = await useCurrentUser();
const { parseManual } = useMockOcr();
const { matchResult, match, apply, reset } = useOcrPicking();

const defaultForm: OcrInput = {
  partNo: "",
  dateCode: "",
  lotCode: "",
  originCountry: "",
  qty: "",
};

const form = ref<OcrInput>({ ...defaultForm });
const parseError = ref<string | null>(null);
const scanning = ref(false);

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      resetState();
    }
  }
);

function resetState() {
  reset();
  form.value = { ...defaultForm };
  parseError.value = null;
  scanning.value = false;
}

async function onScanClick() {
  parseError.value = null;
  scanning.value = true;

  let parsed;
  try {
    parsed = parseManual(form.value);
  } catch (e: any) {
    parseError.value = e?.message ?? "Invalid input";
    scanning.value = false;
    return;
  }

  await match(db, props.receivingOrderId, parsed);
  scanning.value = false;

  if (matchResult.value.status === "single") {
    const { receiving, picking } = matchResult.value;
    await apply(db, receiving, picking, currentUser?.id ?? "");
    if (matchResult.value.status === "success") {
      emit("applied");
    }
  }
}

async function onCandidateClick(candidate: PickingCandidate) {
  if (matchResult.value.status !== "multiple") return;
  await apply(db, matchResult.value.receiving, candidate, currentUser?.id ?? "");
  if (matchResult.value.status === "success") {
    emit("applied");
  }
}

function close() {
  emit("update:modelValue", false);
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

.empty {
  text-align: center;
  color: var(--muted);
  padding: 1rem 0;
}

.error {
  color: var(--danger);
  font-size: 0.875rem;
  margin: 0.75rem 0 0;
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

.field input {
  padding: 0.5rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  color: var(--text);
  font-size: 0.9375rem;
}

.required {
  color: var(--danger);
}

.options {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.option {
  display: flex;
  gap: 0.75rem;
  align-items: center;
  padding: 0.75rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  cursor: pointer;
}

.option:hover {
  border-color: var(--primary);
}

.option .letter {
  font-size: 1.25rem;
}

.option .content h3 {
  margin: 0;
  font-size: 0.9375rem;
}

.option .content p {
  margin: 0.25rem 0 0;
  font-size: 0.8125rem;
  color: var(--muted);
}
</style>
