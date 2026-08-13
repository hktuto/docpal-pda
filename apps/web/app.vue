<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
  <ServerDownOverlay />
</template>

<script setup lang="ts">
import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";

const { start: startServerHealth } = useServerHealth();

// Backend reachability watchdog: drives the global maintenance overlay.
// Skipped on native until a backend is chosen (first boot shows the /server
// picker; pinging the fallback apiBaseUrl could raise a false overlay over it).
onMounted(() => {
  if (!Capacitor.isNativePlatform() || getSavedServerHost()) startServerHealth();
});

let lastBackAt = 0;
const DOUBLE_TAP_MS = 2000;

if (Capacitor.isNativePlatform()) {
  const router = useRouter();
  App.addListener("backButton", ({ canGoBack }) => {
    if (canGoBack) {
      router.back();
      return;
    }
    const now = Date.now();
    if (now - lastBackAt < DOUBLE_TAP_MS) {
      App.exitApp();
    } else {
      lastBackAt = now;
    }
  });
}
</script>
