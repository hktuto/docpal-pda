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
      <div class="userbox">
        <span class="username">{{ user?.displayName }}</span>
        <button class="btn btn-small" @click="logout">{{ $t("admin.auth.logout") }}</button>
      </div>
      <div class="langbox">
        <LanguageSwitcher />
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
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 12px 18px 0;
  border-top: 1px solid #d8e1ea;
  font-size: 13px;
}
.username {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.langbox {
  padding: 10px 18px 0;
}

.content {
  flex: 1;
  min-width: 0;
  padding: 20px 24px 40px;
}
</style>
