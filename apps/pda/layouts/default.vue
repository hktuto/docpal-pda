<template>
  <div class="app">
    <AppHeader />
    <main :class="['container', { 'no-padding': $route?.meta?.props?.noPadding }]">
      <slot />
    </main>
    <ToastHost />
  </div>
</template>

<script setup lang="ts">
const { currentUser } = useAuth();
const events = useWarehouseEvents();
const { loadFlowSteps } = useFlowSteps();

// The event stream follows the session: connect when logged in (including
// after restore()), disconnect on logout. The flow-step config is also
// (re)fetched on login so env-disabled steps hide their home tiles.
watch(
  currentUser,
  (user) => {
    if (user) {
      events.connect();
      void loadFlowSteps();
    } else {
      events.disconnect();
    }
  },
  { immediate: true }
);
</script>

<style scoped>
.container.no-padding {
  padding-top: 0;
}
</style>
