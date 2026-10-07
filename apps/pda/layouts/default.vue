<template>
  <div class="app">
    <AppHeader />
    <main :class="['container', { 'no-padding': $route?.meta?.props?.noPadding }]">
      <slot />
    </main>
    <ToastHost />
    <OutdatedWarningDialog />
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

// Config changes (admin flow-config / display settings) reach the PDA two
// ways: the config.updated SSE event, and a refetch whenever the app returns
// to the foreground (covers a dropped event stream). Without these the config
// was only fetched at login and list pages kept rendering stale settings.
onMounted(() => {
  const unsubscribe = events.subscribe(["/config"], () => void loadFlowSteps());
  const onVisible = () => {
    if (document.visibilityState === "visible" && currentUser.value) void loadFlowSteps();
  };
  document.addEventListener("visibilitychange", onVisible);
  onUnmounted(() => {
    unsubscribe();
    document.removeEventListener("visibilitychange", onVisible);
  });
});
</script>

<style scoped>
.container.no-padding {
  padding-top: 0;
}
</style>
