<script setup lang="ts">
// Unread bug-report count badge for the sidebar nav link (spec
// docs/superpowers/specs/2026-11-05-in-app-bug-report-design.md). No SSE
// topic — refetch on mount and whenever the user leaves the triage page
// (status patches there change the count).
const route = useRoute();
const count = ref(0);

async function refresh() {
  try {
    const res = await useApi().get<{ count: number }>("/admin/bug-reports/count");
    count.value = res.count;
  } catch {
    // best-effort
  }
}

onMounted(refresh);
watch(
  () => route.path,
  (path, prev) => {
    if (prev?.startsWith("/bug-reports") && !path.startsWith("/bug-reports")) refresh();
  }
);
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
  background: #dc2626;
  color: #fff;
  font-size: 0.6875rem;
  font-weight: 700;
  line-height: 1.125rem;
  text-align: center;
  vertical-align: 0.0625rem;
}
</style>
