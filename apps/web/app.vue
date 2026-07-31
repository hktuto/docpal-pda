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
// Skipped on the bundled origin (release-APK launcher): its placeholder
// apiBaseUrl would raise a false overlay over the /server picker.
onMounted(() => {
  if (!isBundledOrigin()) startServerHealth();
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
