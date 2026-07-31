<template>
  <div class="server">
    <div class="server__box">
      <div class="server__brand">
        <svg class="server__logo" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M8 8C8 5.79086 9.79086 4 12 4H28C30.2091 4 32 5.79086 32 8V32C32 34.2091 30.2091 36 28 36H12C9.79086 36 8 34.2091 8 32V8Z" fill="#00BFA5"/>
          <path d="M14 14H26V18H14V14Z" fill="white"/>
          <path d="M14 22H22V26H14V22Z" fill="white" fill-opacity="0.7"/>
        </svg>
        <span class="server__brand-name">{{ $t('login.brand') }}</span>
      </div>
      <h1 class="server__title">{{ $t('server.title') }}</h1>
      <p class="server__subtitle">{{ $t('server.subtitle') }}</p>

      <ul class="server__list">
        <li v-for="host in hosts" :key="host.id">
          <button
            type="button"
            class="server__option"
            :class="{ 'server__option--current': host.url === current }"
            @click="choose(host.url)"
          >
            <span class="server__region">{{ $t(`server.regions.${host.id}`) }}</span>
            <span class="server__url">{{ host.url }}</span>
          </button>
        </li>
      </ul>
    </div>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ layout: false });

const { t } = useI18n();
useHead({ title: t('server.title') });

const hosts = getServerHostOptions();
const current = ref(getSavedServerHost());

function choose(url: string) {
  saveServerHost(url);
  window.location.href = url;
}
</script>

<style scoped>
.server {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  background: linear-gradient(135deg, #00bfa5 0%, #2563eb 100%);
}

.server__box {
  width: 100%;
  max-width: 380px;
  background: rgba(255, 255, 255, 0.9);
  border: 1px solid rgba(255, 255, 255, 0.5);
  border-radius: 1.25rem;
  box-shadow: 0 20px 40px rgba(0, 0, 0, 0.15);
  padding: 1.2rem 1rem;
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
}

.server__brand {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  margin-bottom: 0.25rem;
}

.server__logo {
  width: 2.5rem;
  height: 2.5rem;
}

.server__brand-name {
  font-size: 1.75rem;
  font-weight: 800;
  color: #00bfa5;
  letter-spacing: -0.02em;
}

.server__title {
  text-align: center;
  font-size: 1.125rem;
  color: var(--text);
  margin: 0.5rem 0 0;
}

.server__subtitle {
  text-align: center;
  color: var(--muted);
  margin: 0.25rem 0 1.25rem;
  font-size: 0.9375rem;
}

.server__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.server__option {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  padding: 0.75rem 1rem;
  border: 1.5px solid var(--border, #d1d5db);
  border-radius: 0.75rem;
  background: #fff;
  cursor: pointer;
  text-align: left;
}

.server__option:active {
  background: var(--bg, #f3f4f6);
}

.server__option--current {
  border-color: #00bfa5;
  box-shadow: 0 0 0 1px #00bfa5;
}

.server__region {
  font-size: 1rem;
  font-weight: 700;
  color: var(--text);
}

.server__url {
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 0.75rem;
  color: var(--muted);
  word-break: break-all;
}
</style>
