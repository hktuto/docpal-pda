<script setup lang="ts">
// New-version toast: Nuxt's app manifest detects an outdated build and fires
// `app:manifest:update`; we surface a "reload to update" toast. Mounted once
// in each app's app.vue (comes from the shared app-update layer).
const { t } = useI18n();

const visible = ref(false);

const nuxtApp = useNuxtApp();
nuxtApp.hooks.hookOnce("app:manifest:update", () => {
  setTimeout(() => {
    visible.value = true;
  }, 1000);
});

function reload() {
  window.location.reload();
}

</script>

<template>
  <Teleport to="body">
    <div v-if="visible" class="app-update-toast" role="status">
      <div class="app-update-text">
        <strong>{{ t("appVersionUpdate.title") }}</strong>
        <span>{{ t("appVersionUpdate.message") }}</span>
      </div>
      <button class="app-update-btn" @click="reload">
        {{ t("appVersionUpdate.button") }}
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.app-update-toast {
  position: fixed;
  right: 0.5rem;
  bottom: 0.5rem;
  z-index: 9999;
  display: flex;
  align-items: center;
  gap: 0.25rem;
  max-width: calc(100% - 1rem);
  padding: 0.5rem 0.8rem;
  background: #fff;
  border: 1px solid #d8e1ea;
  border-radius: 0.5rem;
  box-shadow: 0 8px 24px rgba(15, 23, 32, 0.18);
}

.app-update-text {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  font-size: 0.8125rem;
}

.app-update-btn {
  flex-shrink: 0;
  border: none;
  border-radius: 0.375rem;
  padding: 0.5rem 0.875rem;
  font-size: 0.8125rem;
  font-weight: 600;
  color: #fff;
  background: linear-gradient(135deg, #23c3c9, #1b8fd4);
  cursor: pointer;
}
</style>
