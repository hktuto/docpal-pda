import type { MaybeRefOrGetter } from "vue";

export interface PageHeaderInfoRow {
  label: string;
  value: string;
}

export interface PageHeaderAction {
  key: string;
  label: string;
  /** Renders a NuxtLink; the menu closes on navigation. */
  to?: string;
  /** Renders a button — awaited, then the menu closes. */
  onClick?: () => void | Promise<void>;
  danger?: boolean;
  disabled?: boolean;
}

export interface PageHeaderConfig {
  title?: MaybeRefOrGetter<string | undefined>;
  badgeText?: MaybeRefOrGetter<string | undefined>;
  badgeClass?: MaybeRefOrGetter<string | undefined>;
  info?: MaybeRefOrGetter<PageHeaderInfoRow[]>;
  actions?: MaybeRefOrGetter<PageHeaderAction[]>;
}

interface PageHeaderState {
  path: string;
  config: PageHeaderConfig;
}

/**
 * Detail pages register their title/badge/info/actions here so the persistent
 * AppHeader can render them. Every field may be a getter so the header stays
 * live. The state records the registering route's fullPath; consumers apply it
 * only while still on that route, so a stale registration from an unmounted
 * page is ignored — nothing to clear on navigation.
 */
export function usePageHeader(config?: PageHeaderConfig) {
  const state = useState<PageHeaderState | null>("page-header", () => null);
  const route = useRoute();

  if (config) {
    state.value = { path: route.fullPath, config };
  }

  const active = computed<PageHeaderConfig | null>(() =>
    state.value && state.value.path === route.fullPath ? state.value.config : null
  );

  return { active };
}
