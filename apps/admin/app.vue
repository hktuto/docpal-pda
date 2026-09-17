<script setup lang="ts">
import { navSections } from "~/utils/entities";

const route = useRoute();
const user = ref<{ displayName?: string } | null>(null);

// DocPal console link in the user popover; hidden when the backend has no
// DOCPAL_URL configured (or the fetch fails).
const docpalUrl = ref<string | null>(null);
onMounted(async () => {
  try {
    const res = await useApi().get<{ url: string | null }>("/admin/docpal-url");
    docpalUrl.value = res.url;
  } catch {
    docpalUrl.value = null;
  }
});

function refreshUser() {
  if (!import.meta.client) return;
  const raw = localStorage.getItem("admin_user");
  user.value = raw ? JSON.parse(raw) : null;
}

// Per-user date format prefs drive every table date cell; load once a token
// exists (the login page has none — the api client would bounce to /login).
let datePrefsLoaded = false;
function ensureDatePrefs() {
  if (!import.meta.client || datePrefsLoaded) return;
  if (!localStorage.getItem("admin_token")) return;
  datePrefsLoaded = true;
  loadDatePreferences(useApi());
}

watch(() => route.path, refreshUser);
watch(() => route.path, ensureDatePrefs);
onMounted(refreshUser);
onMounted(ensureDatePrefs);

const isLogin = computed(() => route.path === "/login");

// 2-level sidebar: section (expand/collapse) → page links. The section
// containing the active route always stays expanded.
const collapsed = ref<Record<string, boolean>>({});

function isActive(linkRoute: string): boolean {
  return linkRoute === "/" ? route.path === "/" : route.path.startsWith(linkRoute);
}

function isCollapsed(sectionTitle: string, links: { route: string }[]): boolean {
  if (links.some((l) => isActive(l.route))) return false;
  return collapsed.value[sectionTitle] ?? true;
}

function toggle(sectionTitle: string, links: { route: string }[]) {
  collapsed.value[sectionTitle] = !isCollapsed(sectionTitle, links);
}

function logout() {
  localStorage.removeItem("admin_token");
  localStorage.removeItem("admin_user");
  user.value = null;
  navigateTo("/login");
}

// Userbox popover: clicking the username toggles a small menu (language
// switcher + logout) anchored above it; closes on outside click / route change.
const showUserMenu = ref(false);
const userboxEl = ref<HTMLElement | null>(null);

function onDocClick(e: MouseEvent) {
  if (userboxEl.value && !userboxEl.value.contains(e.target as Node)) showUserMenu.value = false;
}

watch(showUserMenu, (open) => {
  if (!import.meta.client) return;
  if (open) document.addEventListener("click", onDocClick, true);
  else document.removeEventListener("click", onDocClick, true);
});
watch(
  () => route.path,
  () => {
    showUserMenu.value = false;
  }
);
onBeforeUnmount(() => {
  if (import.meta.client) document.removeEventListener("click", onDocClick, true);
});
</script>

<template>
  <div v-if="isLogin">
    <NuxtPage />
  </div>
  <div v-else class="layout">
    <aside class="sidebar">
      <NuxtLink to="/" class="brand">
        <img src="/logoWithName.png" alt="DocPal" class="brand-logo" />
        <span class="brand-sub">Warehouse Admin</span>
      </NuxtLink>
      <nav>
        <div v-for="s in navSections" :key="s.title" class="nav-section">
          <button class="nav-section-head" @click="toggle(s.title, s.links)">
            {{ $t(s.title) }}
            <span class="caret" :class="{ open: !isCollapsed(s.title, s.links) }">▸</span>
          </button>
          <div v-show="!isCollapsed(s.title, s.links)" class="nav-links">
            <NuxtLink
              v-for="l in s.links"
              :key="l.route"
              :to="l.route"
              :class="{ 'router-link-active': isActive(l.route) }"
            >
              {{ $t(l.title) }}
            </NuxtLink>
          </div>
        </div>
      </nav>
      <AllocationIndicator />
      <div ref="userboxEl" class="userbox">
        <button class="username" @click="showUserMenu = !showUserMenu">
          {{ user?.displayName }}
        </button>
        <div v-if="showUserMenu" class="user-popover">
          <LanguageSwitcher />
          <NuxtLink to="/settings" class="btn btn-small settings-link">
            {{ $t("admin.auth.settings") }}
          </NuxtLink>
          <a
            v-if="docpalUrl"
            :href="docpalUrl"
            rel="noopener"
            class="btn btn-small settings-link"
          >
            {{ $t("admin.auth.openDocpal") }}
          </a>
          <button class="btn btn-small logout-btn" @click="logout">
            {{ $t("admin.auth.logout") }}
          </button>
        </div>
      </div>
    </aside>
    <main class="content">
      <NuxtPage />
    </main>
  </div>
</template>

<style scoped>
.layout {
  display: flex;
  min-height: 100vh;
}

.sidebar {
  width: 14.375rem;
  flex-shrink: 0;
  background: var(--brand-sidebar-bg);
  color: var(--brand-sidebar-text);
  display: flex;
  flex-direction: column;
  padding: 0.875rem 0;
  position: sticky;
  top: 0;
  height: 100vh;
  overflow-y: auto;
  border-right: 1px solid #d8e1ea;
}

.brand {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  padding: 0 1.125rem 0.75rem;
  border-bottom: 1px solid #d8e1ea;
  margin-bottom: 0.5rem;
}
.brand:hover {
  text-decoration: none;
}
.brand-logo {
  width: 8.25rem;
  display: block;
}
.brand-sub {
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: #7b8794;
}

.sidebar nav {
  flex: 1;
}

.nav-section-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.375rem;
  width: 100%;
  border: none;
  background: none;
  color: #64748b;
  font-size: 0.8125rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 0.5rem 1.125rem 0.25rem;
  cursor: pointer;
  background: var(--brand-hightlight-bg);
}
.nav-section-head:hover {
  color: var(--brand-sidebar-text);
}

.caret {
  display: inline-block;
  font-size: 0.625rem;
  transition: transform 0.12s ease;
}
.caret.open {
  transform: rotate(90deg);
}

.nav-links {
  display: flex;
  flex-direction: column;
  padding-block: 0.25rem;
}
.nav-links a {
  color: var(--brand-sidebar-text);
  padding: 0.375rem 0.375rem;
  margin: 0.0625rem 0.625rem;
  border-radius: 0.5rem;
  font-size: 0.875rem;
}
.nav-links a:hover {
  color: var(--brand-teal-dark);
  background: rgba(15, 181, 163, 0.1);
  text-decoration: none;
}
.nav-links a.router-link-active {
  color: #fff;
  background: linear-gradient(135deg, #23c3c9, var(--brand-blue));
  box-shadow: 0 2px 6px rgba(27, 143, 212, 0.3);
}

.userbox {
  position: relative;
  padding: 0.75rem 1.125rem 0;
  border-top: 1px solid #d8e1ea;
  font-size: 0.8125rem;
}
.username {
  display: block;
  width: 100%;
  border: none;
  background: none;
  padding: 0;
  font-size: 0.8125rem;
  color: var(--brand-sidebar-text);
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}
.username:hover {
  color: var(--brand-teal-dark);
}
.user-popover {
  position: absolute;
  bottom: calc(100% + 0.375rem);
  left: 0.625rem;
  width: 11.25rem;
  background: #fff;
  border: 1px solid #d8e1ea;
  border-radius: 0.5rem;
  box-shadow: 0 8px 24px rgba(15, 23, 32, 0.18);
  padding: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.625rem;
}
.logout-btn {
  align-self: flex-start;
}
.settings-link {
  align-self: flex-start;
  display: inline-block;
  text-align: center;
}
.settings-link:hover {
  text-decoration: none;
}

.content {
  flex: 1;
  min-width: 0;
  padding: 1.25rem 1.5rem 2.5rem;
}
</style>
