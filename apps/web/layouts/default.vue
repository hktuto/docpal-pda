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

// The event stream follows the session: connect when logged in (including
// after restore()), disconnect on logout.
watch(
  currentUser,
  (user) => {
    if (user) events.connect();
    else events.disconnect();
  },
  { immediate: true }
);
</script>

<style scoped>
.container.no-padding {
  padding-top: 0;
}
</style>
