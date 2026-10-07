<script setup lang="ts">
// Warning chip on order detail pages (spec
// docs/superpowers/specs/2026-10-07-supplier-outdated-datecode-warning-design.md):
// shown when an order has unresolved outdated date-code scan warnings; links
// to the warnings page pre-filtered to the order's flow.
defineProps<{
  count: number;
  orderKind: "picking" | "putaway";
}>();
</script>

<template>
  <NuxtLink v-if="count > 0" :to="`/outdated-warnings?orderKind=${orderKind}`" class="outdated-chip">
    ⚠ {{ $t("admin.pages.outdatedWarnings.chip", { count }) }}
  </NuxtLink>
</template>

<style scoped>
.outdated-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.1875rem 0.625rem;
  border-radius: 999px;
  background: #fdf3d7;
  border: 1px solid #e8c96a;
  color: #8a6d1a;
  font-size: 0.8125rem;
  font-weight: 600;
  white-space: nowrap;
  text-decoration: none;
}
.outdated-chip:hover {
  background: #fbeabc;
  text-decoration: none;
}
</style>
