<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
  <ServerDownOverlay />
  <AppUpdate />
  <LazyDevScanSimulator v-if="devOnly" />
</template>

<script setup lang="ts">
import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";

const { start: startServerHealth } = useServerHealth();

// Dev-only scan simulator overlay (components/DevScanSimulator.vue).
const devOnly = import.meta.dev;

// Order-link QR scans (admin shipper / picking-list Excel) navigate globally,
// from every page — including home and the order lists, which register no
// page-level scanner composable.
useOrderScanNav();

// Backend reachability watchdog: drives the global maintenance overlay.
// Skipped on native until a backend is chosen (first boot shows the /server
// picker; pinging the fallback apiBaseUrl could raise a false overlay over it).
onMounted(() => {
  if (!Capacitor.isNativePlatform() || getSavedServerHost()) startServerHealth();
});

let lastBackAt = 0;
const DOUBLE_TAP_MS = 2000;

if (Capacitor.isNativePlatform()) {
  // Undo any scanner-symbology restriction a previous run left behind.
  restoreScannerSymbologies();

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
