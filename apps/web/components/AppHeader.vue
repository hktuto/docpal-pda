<template>
  <header class="app-header">
    <button
      v-if="showBack"
      class="app-header__back"
      :aria-label="t('appHeader.goBack')"
      @click="goBack"
    >
      <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="m15 18-6-6 6-6"/>
      </svg>
    </button>
    <NuxtLink
      v-if="showBack"
      to="/"
      class="app-header__home"
      :aria-label="t('appHeader.home')"
    >
      <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
        <polyline points="9 22 9 12 15 12 15 22"/>
      </svg>
    </NuxtLink>
    <NuxtLink v-else to="/" class="app-header__logo" :aria-label="t('appHeader.home')">
      <svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M8 8C8 5.79086 9.79086 4 12 4H28C30.2091 4 32 5.79086 32 8V32C32 34.2091 30.2091 36 28 36H12C9.79086 36 8 34.2091 8 32V8Z" fill="#00BFA5"/>
        <path d="M14 14H26V18H14V14Z" fill="white"/>
        <path d="M14 22H22V26H14V22Z" fill="white" fill-opacity="0.7"/>
      </svg>
    </NuxtLink>

    <h1 class="app-header__title">{{ title }}</h1>

    <div ref="menuRef" class="app-header__menu">
      <button
        type="button"
        class="app-header__menu-toggle"
        :aria-label="t('appHeader.menu')"
        :title="t('appHeader.menu')"
        :aria-expanded="menuOpen"
        @click="menuOpen = !menuOpen"
      >
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="6" r="1.5"/>
          <circle cx="12" cy="12" r="1.5"/>
          <circle cx="12" cy="18" r="1.5"/>
        </svg>
      </button>
      <div v-if="menuOpen" class="app-header__menu-body">
        <div class="app-header__menu-row">
          <LanguageSwitcher />
        </div>
        <button class="app-header__menu-row app-header__menu-row--danger" @click="resetDb">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
            <path d="M3 3v5h5"/>
          </svg>
          <span>{{ t('appHeader.resetDb') }}</span>
        </button>
        <button class="app-header__menu-row" @click="logout">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
            <polyline points="16 17 21 12 16 7"/>
            <line x1="21" x2="9" y1="12" y2="12"/>
          </svg>
          <span>{{ t('appHeader.logout') }}</span>
        </button>
      </div>
    </div>
  </header>
</template>

<script setup lang="ts">
const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const { logout: authLogout } = useAuth();
const pg = useNuxtApp().$pglite;

const menuOpen = ref(false);
const menuRef = ref<HTMLElement | null>(null);

function closeMenuOnOutsideClick(event: MouseEvent) {
  if (
    menuOpen.value &&
    menuRef.value &&
    !menuRef.value.contains(event.target as Node)
  ) {
    menuOpen.value = false;
  }
}

onMounted(() => document.addEventListener("click", closeMenuOnOutsideClick));
onUnmounted(() => document.removeEventListener("click", closeMenuOnOutsideClick));

const title = computed(() => {
  const metaTitle = route.meta.title as string | undefined;
  if (!metaTitle) return t("meta.warehouse");
  const translated = t(metaTitle);
  return translated !== metaTitle ? translated : metaTitle;
});
const showBack = computed(() => route.path !== "/");

function goBack() {
  if (window.history.length > 1) {
    router.back();
  } else {
    navigateTo("/");
  }
}

function logout() {
  authLogout();
  navigateTo("/login");
}

async function resetDb() {
  if (!confirm(t("appHeader.resetConfirm"))) return;

  if (pg) {
    await pg.close();
  }

  const dbName = "/pglite/warehouse-demo-pglite";
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(dbName);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });

  localStorage.clear();
  window.location.reload();
}
</script>

<style scoped>
.app-header__menu {
  position: relative;
}

.app-header__menu-toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 2.25rem;
  height: 2.25rem;
  border: none;
  border-radius: var(--radius);
  cursor: pointer;
  color: var(--text);
  background: transparent;
}

.app-header__menu-toggle::-webkit-details-marker {
  display: none;
}

.app-header__menu-toggle:hover {
  background: var(--bg);
}

.app-header__menu-body {
  position: absolute;
  top: calc(100% + 0.5rem);
  right: 0;
  min-width: 12rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 0.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  z-index: 100;
}

.app-header__menu-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  padding: 0.5rem 0.625rem;
  border: none;
  border-radius: var(--radius);
  background: transparent;
  color: var(--text);
  font-size: 0.875rem;
  text-align: left;
  cursor: pointer;
}

.app-header__menu-row:hover {
  background: var(--bg);
}

.app-header__menu-row--danger {
  color: var(--danger);
}

.app-header__menu-row--danger:hover {
  background: #fef2f2;
}

.app-header__logo {
  width: 2.25rem;
  height: 2.25rem;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0.375rem;
  border-radius: var(--radius);
}

.app-header__logo:hover {
  background: var(--bg);
}

.app-header__logo svg {
  width: 100%;
  height: 100%;
}

.app-header__action--reset {
  color: var(--muted);
}
</style>
