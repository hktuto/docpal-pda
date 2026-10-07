<template>
  <Teleport to="body">
    <div
      v-if="current"
      class="modal-overlay"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="outdated-warning-title"
    >
      <div class="modal">
        <div class="modal__header">
          <h3 id="outdated-warning-title">{{ $t("outdatedWarning.title") }}</h3>
        </div>
        <div class="modal__body">
          <p class="outdated-warning__message">
            {{
              $t("outdatedWarning.message", {
                dateCode: current.dateCode,
                supplierCode: current.supplierCode,
                limitMonths: current.limitMonths,
              })
            }}
          </p>
          <div class="actions">
            <button type="button" class="btn btn--full" autofocus @click="dismissOutdatedWarning">
              {{ $t("outdatedWarning.confirm") }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import {
  dismissOutdatedWarning,
  useOutdatedWarningState,
} from "~/composables/useOutdatedWarning";

// One dismissible alert per queued warning (spec 2026-10-07 supplier outdated
// date-code warning): the scan already succeeded server-side — dismissing
// reveals the next queued warning and scanning continues.
const { current } = useOutdatedWarningState();
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
  /* Above the toast host (z-index 1000). */
  z-index: 1100;
}

.modal {
  background: var(--surface);
  border: 1px solid var(--warning);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  width: 100%;
  max-width: calc(100vw - 2rem);
  max-height: 90vh;
  overflow-y: auto;
}

.modal__header {
  padding: 1rem;
  border-bottom: 1px solid var(--border);
  background: var(--warning-soft);
  color: #92400e;
}

.modal__header h3 {
  margin: 0;
  font-size: 1rem;
}

.modal__body {
  padding: 1rem;
}

.outdated-warning__message {
  margin: 0;
  font-size: 1rem;
}

.actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 1rem;
}

.actions .btn {
  flex: 1;
}
</style>
