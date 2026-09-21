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

    <div class="app-header__heading">
      <h1 class="app-header__title">{{ title }}</h1>
      <span
        v-if="pageBadgeText"
        class="badge app-header__badge"
        :class="pageBadgeClass"
      >{{ pageBadgeText }}</span>
    </div>

    <div v-if="hasPageMenu" ref="pageMenuRef" class="app-header__menu">
      <button
        type="button"
        class="app-header__menu-toggle"
        :aria-label="t('appHeader.pageMenu')"
        :title="t('appHeader.pageMenu')"
        :aria-expanded="pageMenuOpen"
        @click="togglePageMenu"
      >
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="5" cy="12" r="1.5"/>
          <circle cx="12" cy="12" r="1.5"/>
          <circle cx="19" cy="12" r="1.5"/>
        </svg>
      </button>
      <div v-if="pageMenuOpen" class="app-header__menu-body">
        <div
          v-for="row in pageInfo"
          :key="row.label"
          class="app-header__menu-info"
        >
          <span class="app-header__menu-info-label">{{ row.label }}</span>
          <span class="app-header__menu-info-value">{{ row.value }}</span>
        </div>
        <div
          v-if="pageInfo.length && pageActions.length"
          class="app-header__menu-divider"
        />
        <template v-for="action in pageActions" :key="action.key">
          <NuxtLink
            v-if="action.to"
            :to="action.to"
            class="app-header__menu-row"
            :class="{ 'app-header__menu-row--danger': action.danger }"
            @click="pageMenuOpen = false"
          >
            <span>{{ action.label }}</span>
          </NuxtLink>
          <button
            v-else
            type="button"
            class="app-header__menu-row"
            :class="{ 'app-header__menu-row--danger': action.danger }"
            :disabled="action.disabled"
            @click="runPageAction(action)"
          >
            <span>{{ action.label }}</span>
          </button>
        </template>
      </div>
    </div>

    <div ref="menuRef" class="app-header__menu">
      <button
        type="button"
        class="app-header__menu-toggle"
        :aria-label="t('appHeader.menu')"
        :title="t('appHeader.menu')"
        :aria-expanded="menuOpen"
        @click="toggleMenu"
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
        <button class="app-header__menu-row" @click="openSettings">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
          <span>{{ t('appHeader.settings') }}</span>
        </button>
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
import type { PageHeaderAction } from "~/composables/usePageHeader";

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const { logout: authLogout } = useAuth();
const warehouse = useWarehouse();

const menuOpen = ref(false);
const menuRef = ref<HTMLElement | null>(null);
const pageMenuOpen = ref(false);
const pageMenuRef = ref<HTMLElement | null>(null);

function closeMenuOnOutsideClick(event: MouseEvent) {
  const target = event.target as Node;
  if (
    menuOpen.value &&
    menuRef.value &&
    !menuRef.value.contains(target)
  ) {
    menuOpen.value = false;
  }
  if (
    pageMenuOpen.value &&
    pageMenuRef.value &&
    !pageMenuRef.value.contains(target)
  ) {
    pageMenuOpen.value = false;
  }
}

onMounted(() => document.addEventListener("click", closeMenuOnOutsideClick));
onUnmounted(() => document.removeEventListener("click", closeMenuOnOutsideClick));

function toggleMenu() {
  menuOpen.value = !menuOpen.value;
  pageMenuOpen.value = false;
}

function togglePageMenu() {
  pageMenuOpen.value = !pageMenuOpen.value;
  menuOpen.value = false;
}

// Whatever the mounted detail page registered — ignored once the route moves
// on, so list pages keep the static meta title with no clearing dance.
const { active: pageHeader } = usePageHeader();

const pageTitle = computed(() => {
  const value = pageHeader.value?.title;
  return value !== undefined ? toValue(value) : undefined;
});
const pageBadgeText = computed(() => {
  const value = pageHeader.value?.badgeText;
  const resolved = value !== undefined ? toValue(value) : undefined;
  return resolved || undefined;
});
const pageBadgeClass = computed(() => {
  const value = pageHeader.value?.badgeClass;
  return value !== undefined ? toValue(value) : undefined;
});
const pageInfo = computed(() => toValue(pageHeader.value?.info) ?? []);
const pageActions = computed(() => toValue(pageHeader.value?.actions) ?? []);
const hasPageMenu = computed(
  () => pageInfo.value.length > 0 || pageActions.value.length > 0
);

async function runPageAction(action: PageHeaderAction) {
  if (!action.onClick) return;
  await action.onClick();
  pageMenuOpen.value = false;
}

// Either menu left open would float over the next page — close on navigation.
watch(
  () => route.fullPath,
  () => {
    menuOpen.value = false;
    pageMenuOpen.value = false;
  }
);

const title = computed(() => {
  if (pageTitle.value) return pageTitle.value;
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
  useWarehouseEvents().disconnect();
  authLogout();
  navigateTo("/login");
}

function openSettings() {
  menuOpen.value = false;
  navigateTo("/settings");
}

async function resetDb() {
  if (!confirm(t("appHeader.resetConfirm"))) return;

  await warehouse.resetDemoData();

  localStorage.clear();
  window.location.reload();
}
</script>

<style scoped>
.app-header__heading {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.app-header__heading .app-header__title {
  margin-right: 0;
}

.app-header__badge {
  flex-shrink: 0;
  font-size: 0.625rem;
  padding: 0.12rem 0.4rem;
  letter-spacing: 0.03em;
}

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
  text-decoration: none;
  cursor: pointer;
}

.app-header__menu-row:hover {
  background: var(--bg);
}

.app-header__menu-row:disabled {
  opacity: 0.5;
  cursor: default;
}

.app-header__menu-row:disabled:hover {
  background: transparent;
}

.app-header__menu-info {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 0.75rem;
  padding: 0.35rem 0.625rem;
  font-size: 0.8125rem;
  color: var(--text);
}

.app-header__menu-info-label {
  flex-shrink: 0;
  color: var(--muted);
  font-size: 0.6875rem;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.app-header__menu-info-value {
  min-width: 0;
  text-align: right;
  word-break: break-word;
}

.app-header__menu-divider {
  height: 1px;
  background: var(--border);
  margin: 0.25rem 0;
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
