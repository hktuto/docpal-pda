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
onMounted(startServerHealth);

const SUPPORTED_LOCALES = ["en-US", "zh-CN", "zh-HK"] as const;
type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];
const STORAGE_KEY = "warehouse-locale";

const { locale, setLocale } = useI18n();

onMounted(() => {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved && SUPPORTED_LOCALES.includes(saved as SupportedLocale)) {
    setLocale(saved as SupportedLocale);
  }
});

watch(locale, (code) => {
  if (SUPPORTED_LOCALES.includes(code as SupportedLocale)) {
    localStorage.setItem(STORAGE_KEY, code);
  }
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
