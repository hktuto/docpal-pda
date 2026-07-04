<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
</template>

<script setup lang="ts">
useAndroidBackButton();

onMounted(() => {
  useLocalePreference().restore();
});
</script>
