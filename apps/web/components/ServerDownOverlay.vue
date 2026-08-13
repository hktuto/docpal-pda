<template>
  <div v-if="serverDown && !onPicker" class="server-down" role="alert">
    <div class="server-down__card">
      <h1 class="server-down__title">{{ $t("common.serverDownTitle") }}</h1>
      <p class="server-down__message">{{ $t("common.serverDownMessage") }}</p>
      <button class="server-down__retry" :disabled="checking" @click="checkServer">
        {{ checking ? $t("common.serverDownChecking") : $t("common.serverDownRetry") }}
      </button>
      <button v-if="isNative" class="server-down__change" @click="onChangeServer">
        {{ $t("login.changeServer") }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Capacitor } from "@capacitor/core";

const { serverDown, checking, checkServer } = useServerHealth();

// Escape hatch when the chosen backend is dead for good — otherwise the
// overlay bricks the app with no way back to the /server picker.
const isNative = Capacitor.isNativePlatform();

// Never cover the /server picker itself — that page is the way out.
const route = useRoute();
const onPicker = computed(() => route.path === "/server");

function onChangeServer() {
  return navigateTo("/server");
}
</script>

<style scoped>
.server-down {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(17, 24, 39, 0.85);
  padding: 1.5rem;
}

.server-down__card {
  background: var(--surface, #fff);
  border-radius: 12px;
  padding: 2rem 1.5rem;
  max-width: 420px;
  width: 100%;
  text-align: center;
}

.server-down__title {
  font-size: 1.2rem;
  margin: 0 0 0.5rem;
}

.server-down__message {
  color: var(--muted);
  font-size: 0.95rem;
  margin: 0 0 1.25rem;
}

.server-down__retry {
  width: 100%;
  padding: 0.75rem;
  border: none;
  border-radius: var(--radius, 8px);
  background: var(--primary);
  color: #fff;
  font-size: 1rem;
  cursor: pointer;
}

.server-down__retry:disabled {
  opacity: 0.6;
  cursor: default;
}

.server-down__change {
  width: 100%;
  padding: 0.75rem;
  margin-top: 0.5rem;
  border: none;
  border-radius: var(--radius, 8px);
  background: var(--muted, #6b7280);
  color: #fff;
  font-size: 1rem;
  cursor: pointer;
}
</style>
