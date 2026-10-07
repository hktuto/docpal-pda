<script setup lang="ts">
// Pending outdated-warning count badge for the sidebar nav link (spec
// docs/superpowers/specs/2026-10-07-supplier-outdated-datecode-warning-design.md).
// Same fetch + SSE pattern as AllocationIndicator.
const flow = useFlowApi();
const events = useAdminEvents();
const count = ref(0);

async function refresh() {
  try {
    const rows = await flow.listOutdatedWarnings({ resolved: false });
    count.value = rows.length;
  } catch {
    // best-effort — the SSE events will correct it
  }
}

let unsubs: (() => void)[] = [];
onMounted(() => {
  refresh();
  unsubs = [
    events.subscribe("outdated.warning.created", () => refresh()),
    events.subscribe("outdated.warning.resolved", () => refresh()),
  ];
});
onBeforeUnmount(() => unsubs.forEach((u) => u()));
</script>

<template>
  <span v-if="count > 0" class="nav-warn-badge">{{ count > 99 ? "99+" : count }}</span>
</template>

<style scoped>
.nav-warn-badge {
  display: inline-block;
  margin-left: 0.375rem;
  min-width: 1.125rem;
  padding: 0 0.3125rem;
  border-radius: 999px;
  background: #d97706;
  color: #fff;
  font-size: 0.6875rem;
  font-weight: 700;
  line-height: 1.125rem;
  text-align: center;
  vertical-align: 0.0625rem;
}
</style>
