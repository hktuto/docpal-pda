<script setup lang="ts">
// Global "background allocation running" chip in the sidebar. Covers the
// long-running full allocateAll runs triggered by order changes (create /
// cancel / reorder / picks / sync). The scoped confirm-arrival recompute is
// synchronous and handled by the receiving detail page itself.
// State comes from GET /allocation/status (catches runs already in flight
// when the app loads) plus the allocation.started / allocation.finished SSE
// events; a finished event re-fetches the status because a scoped run's
// finished can arrive while a background run is still going.
const api = useApi();
const events = useAdminEvents();
const running = ref(false);

async function refresh() {
  try {
    const s = await api.get<{ running: boolean }>("/allocation/status");
    running.value = s.running;
  } catch {
    // status is best-effort — SSE events will correct it
  }
}

let unsubs: (() => void)[] = [];
onMounted(() => {
  refresh();
  unsubs = [
    events.subscribe("allocation.started", () => {
      running.value = true;
    }),
    events.subscribe("allocation.finished", () => refresh()),
  ];
});
onBeforeUnmount(() => unsubs.forEach((u) => u()));
</script>

<template>
  <div v-if="running" class="alloc-indicator">
    <span class="alloc-spinner">⟳</span> {{ $t("admin.common.allocating") }}
  </div>
</template>

<style scoped>
.alloc-indicator {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  margin: 0.25rem 1.125rem 0;
  padding: 0.375rem 0.625rem;
  border-radius: 0.375rem;
  background: rgba(240, 220, 160, 0.18);
  border: 1px solid rgba(240, 220, 160, 0.45);
  color: #b08d2a;
  font-size: 0.75rem;
}
.alloc-spinner {
  display: inline-block;
  animation: alloc-spin 1.2s linear infinite;
}
@keyframes alloc-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
