<template>
  <Teleport to="body">
    <div
      v-if="modelValue"
      class="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="scan-modal-title"
      @click.self="close"
    >
      <div
        ref="modalRef"
        class="modal"
        tabindex="-1"
      >
        <div class="modal__header">
          <h3 id="scan-modal-title">Scan label</h3>
          <button type="button" class="modal__close" aria-label="Close" @click="close">×</button>
        </div>

        <div class="modal__body">
          <div v-if="localError">
            <div class="card card--danger">
              <p><strong>Error</strong></p>
              <p class="subtitle">{{ localError }}</p>
            </div>
            <button
              type="button"
              class="btn btn--full"
              @click="resetState"
            >
              Try again
            </button>
          </div>

          <template v-else-if="matchResult.status === 'idle' || matchResult.status === 'scanning'">
            <p class="subtitle">Tap a predefined label to simulate OCR capture.</p>
            <p v-if="presetsLoading" class="empty">Loading presets…</p>
            <p v-else-if="presetsError" class="empty" style="color: var(--danger);">{{ presetsError }}</p>
            <div v-else-if="presets.length === 0" class="empty">No scan presets available.</div>
            <div v-else class="options">
              <button
                v-for="preset in presets"
                :key="preset.id"
                type="button"
                class="option"
                :disabled="matchResult.status === 'scanning' || matchResult.status === 'applying'"
                @click="onPresetClick(preset)"
              >
                <div class="letter">📷</div>
                <div class="content">
                  <h3>{{ preset.rawText }}</h3>
                  <p>{{ preset.parsed.partNo }} · qty {{ preset.parsed.qty }}</p>
                </div>
              </button>
            </div>
          </template>

          <template v-else-if="matchResult.status === 'single'">
            <div class="card card--success">
              <p><strong>{{ matchResult.picking.pickingOrderRefNo }}</strong></p>
              <p class="subtitle">Match found — applying pick…</p>
            </div>
          </template>

          <template v-else-if="matchResult.status === 'multiple'">
            <p class="subtitle">Multiple orders need this item. Choose one.</p>
            <div class="options">
              <button
                v-for="candidate in matchResult.picking"
                :key="candidate.pickingItemId"
                type="button"
                class="option"
                :disabled="matchResult.status === 'scanning' || matchResult.status === 'applying'"
                @click="onCandidateClick(candidate)"
              >
                <div class="letter">📦</div>
                <div class="content">
                  <h3>{{ candidate.pickingOrderRefNo }}</h3>
                  <p>Ship to: {{ candidate.shipTo || "—" }} · still needs {{ candidate.remainingQty }}</p>
                </div>
              </button>
            </div>
          </template>

          <template v-else-if="matchResult.status === 'no_match'">
            <div class="card card--danger">
              <p><strong>No match</strong></p>
              <p class="subtitle">{{ matchResult.reason }}</p>
            </div>
            <button
              type="button"
              class="btn btn--full"
              :disabled="matchResult.status === 'scanning' || matchResult.status === 'applying'"
              @click="resetState"
            >
              Try again
            </button>
          </template>

          <template v-else-if="matchResult.status === 'applying'">
            <p class="empty">Applying pick…</p>
          </template>

          <template v-else-if="matchResult.status === 'success'">
            <div class="card card--success">
              <p><strong>Pick applied</strong></p>
              <p class="subtitle">{{ matchResult.qty }} pcs added to {{ matchResult.pickingOrderRefNo }}</p>
            </div>
            <button
              type="button"
              class="btn btn--full"
              @click="close"
            >
              Done
            </button>
          </template>

          <template v-else-if="matchResult.status === 'error'">
            <div class="card card--danger">
              <p><strong>Error</strong></p>
              <p class="subtitle">{{ matchResult.message }}</p>
            </div>
            <button
              type="button"
              class="btn btn--full"
              :disabled="matchResult.status === 'scanning' || matchResult.status === 'applying'"
              @click="resetState"
            >
              Try again
            </button>
          </template>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, nextTick } from "vue";
import type { MockPreset } from "~/composables/useMockOcr";
import type { PickingCandidate } from "~/db/ocrPicking";

const props = defineProps<{
  modelValue: boolean;
  receivingOrderId: string;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: boolean): void;
  (e: "applied"): void;
}>();

const db = useDb();
const currentUserPromise = useCurrentUser();
const { generatePresets, scan } = useMockOcr();
const { matchResult, match, apply, reset } = useOcrPicking();

const presets = ref<MockPreset[]>([]);
const presetsLoading = ref(false);
const presetsError = ref<string | null>(null);
const localError = ref<string | null>(null);
const modalRef = ref<HTMLElement | null>(null);

watch(
  () => props.modelValue,
  async (open) => {
    if (open) {
      localError.value = null;
      reset();
      loadPresets();
      await nextTick();
      modalRef.value?.focus();
    }
  }
);

async function loadPresets() {
  presetsLoading.value = true;
  presetsError.value = null;
  try {
    presets.value = await generatePresets(db, props.receivingOrderId);
  } catch (e: any) {
    presetsError.value = e?.message ?? "Failed to load presets";
  } finally {
    presetsLoading.value = false;
  }
}

async function onPresetClick(preset: MockPreset) {
  const user = await currentUserPromise;
  if (!user) {
    localError.value = "No operator user found";
    return;
  }
  const parsed = scan(preset);
  await match(db, props.receivingOrderId, parsed);

  if (matchResult.value.status === "single") {
    const { receiving, picking } = matchResult.value;
    await apply(db, receiving, picking, user.id);
    if (matchResult.value.status === "success") {
      emit("applied");
    }
  }
}

async function onCandidateClick(candidate: PickingCandidate) {
  const user = await currentUserPromise;
  if (!user) {
    localError.value = "No operator user found";
    return;
  }
  if (matchResult.value.status !== "multiple") return;
  await apply(db, matchResult.value.receiving, candidate, user.id);
  if (matchResult.value.status === "success") {
    emit("applied");
  }
}

function resetState() {
  localError.value = null;
  reset();
  loadPresets();
}

function close() {
  localError.value = null;
  emit("update:modelValue", false);
}

function onKeydown(event: KeyboardEvent) {
  if (!props.modelValue) return;
  if (event.key === "Escape") {
    close();
  }
}

onMounted(() => window.addEventListener("keydown", onKeydown));
onUnmounted(() => window.removeEventListener("keydown", onKeydown));
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

.modal:focus {
  outline: none;
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

.modal__close:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 2px;
  border-radius: var(--radius);
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

.options {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.option {
  display: flex;
  gap: 0.75rem;
  align-items: center;
  width: 100%;
  text-align: left;
  padding: 0.75rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  cursor: pointer;
  font: inherit;
}

.option:hover:not(:disabled) {
  border-color: var(--primary);
}

.option:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.option:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 2px;
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

.card--success {
  border-left: 4px solid var(--success, #16a34a);
}

.card--danger {
  border-left: 4px solid var(--danger);
}

.btn--full {
  width: 100%;
  margin-top: 1rem;
}

/* Neutralize global .card hover transform inside this modal */
.modal__body .card:hover {
  transform: none;
  box-shadow: var(--shadow);
}
</style>
