<script setup lang="ts">


</script>

<template>
  <div class="app">
    <AppHeader />
    <main :class="['container', { 'no-padding': $route?.meta?.props?.noPadding }]">
      <slot />
    </main>
  </div>
</template>


<style lang="scss" scoped>
.container{
    &.no-padding{
        padding-top: 0px;
    }
}
</style>
