<script setup lang="ts">


</script>

<template>
  <div class="app">
    <AppHeader />
    <main :class="['container', { 'no-padding': $route?.meta?.props?.noPadding }]">
      <slot />
    </main>
    <ToastHost />
  </div>
</template>


<style scoped>
.container.no-padding {
  padding-top: 0;
}
</style>
