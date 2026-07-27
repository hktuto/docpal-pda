<script setup lang="ts">
import { navSections } from "~/utils/entities";

const route = useRoute();
const user = ref<{ displayName?: string } | null>(null);

function refreshUser() {
  if (!import.meta.client) return;
  const raw = localStorage.getItem("admin_user");
  user.value = raw ? JSON.parse(raw) : null;
}

watch(() => route.path, refreshUser);
onMounted(refreshUser);

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
            <span class="caret" :class="{ open: !isCollapsed(s.title, s.links) }">▸</span>
            {{ $t(s.title) }}
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
      <div ref="userboxEl" class="userbox">
        <button class="username" @click="showUserMenu = !showUserMenu">
          {{ user?.displayName }}
        </button>
        <div v-if="showUserMenu" class="user-popover">
          <LanguageSwitcher />
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
  width: 230px;
  flex-shrink: 0;
  background: var(--brand-sidebar-bg);
  color: var(--brand-sidebar-text);
  display: flex;
  flex-direction: column;
  padding: 14px 0;
  position: sticky;
  top: 0;
  height: 100vh;
  overflow-y: auto;
  border-right: 1px solid #d8e1ea;
}

.brand {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 0 18px 12px;
  border-bottom: 1px solid #d8e1ea;
  margin-bottom: 8px;
}
.brand:hover {
  text-decoration: none;
}
.brand-logo {
  width: 132px;
  display: block;
}
.brand-sub {
  font-size: 11px;
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
  align-items: center;
  gap: 6px;
  width: 100%;
  border: none;
  background: none;
  color: #64748b;
  font-size: 13px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 8px 18px 4px;
  cursor: pointer;
}
.nav-section-head:hover {
  color: var(--brand-sidebar-text);
}

.caret {
  display: inline-block;
  font-size: 10px;
  transition: transform 0.12s ease;
}
.caret.open {
  transform: rotate(90deg);
}

.nav-links {
  display: flex;
  flex-direction: column;
  padding-bottom: 4px;
}
.nav-links a {
  color: var(--brand-sidebar-text);
  padding: 6px 18px;
  margin: 1px 10px;
  border-radius: 8px;
  font-size: 14px;
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
  padding: 12px 18px 0;
  border-top: 1px solid #d8e1ea;
  font-size: 13px;
}
.username {
  display: block;
  width: 100%;
  border: none;
  background: none;
  padding: 0;
  font-size: 13px;
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
  bottom: calc(100% + 6px);
  left: 10px;
  width: 180px;
  background: #fff;
  border: 1px solid #d8e1ea;
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(15, 23, 32, 0.18);
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.logout-btn {
  align-self: flex-start;
}

.content {
  flex: 1;
  min-width: 0;
  padding: 20px 24px 40px;
}
</style>
