import { ref, readonly } from "vue";
import { invalidatePrefix } from "~/services/apiCache";
import { getToken } from "~/services/adapters/apiAuth";
import { useToast } from "~/composables/useToast";

/**
 * Server-sent events bus (design:
 * docs/superpowers/specs/2026-07-18-sse-events-and-swr-cache-design.md).
 *
 * Module-level singleton (same pattern as useToast): one EventSource for the
 * whole app, a persisted `wms-events-last-id` cursor used for the manual
 * reconnect loop (never the browser's Last-Event-ID auto-reconnect), topic
 * subscribers for mounted pages, and toasts for "new work" events. Every
 * event also invalidates its topics in the api cache (imported directly —
 * apiCache has no imports back, so there is no cycle).
 */

export interface WarehouseEvent {
  id: number;
  type: string;
  topics: string[];
  data: Record<string, unknown>;
  createdAt: string;
}

export type WarehouseEventCallback = (event: WarehouseEvent) => void;

// The backend's event catalog (its emitEvent call sites). Unknown types are
// ignored: no listener is registered for them.
const KNOWN_EVENT_TYPES = [
  "allocation.computed",
  "picking_order.created",
  "picking_order.updated",
  "goods_verify.tasks_created",
  "receiving_order.upserted",
] as const;

// Only "new work" events toast; the rest are cache invalidation only.
const TOASTS: Record<string, { key: string; to: string }> = {
  "allocation.computed": { key: "event_allocation_computed", to: "/picking" },
  "picking_order.created": { key: "event_picking_order_created", to: "/picking" },
  "goods_verify.tasks_created": {
    key: "event_goods_verify_tasks_created",
    to: "/goods-verify",
  },
};

const LAST_ID_KEY = "wms-events-last-id";
const INITIAL_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 30000;
const BACKOFF_FACTOR = 1.5;

const connected = ref(false);
const subscribers: { topics: string[]; cb: WarehouseEventCallback }[] = [];
let es: EventSource | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let backoffMs = INITIAL_BACKOFF_MS;
let lastEventId: number | null = null;

function readCursor(): number {
  try {
    return Number(localStorage.getItem(LAST_ID_KEY)) || 0;
  } catch {
    return 0;
  }
}

function writeCursor(id: number): void {
  try {
    localStorage.setItem(LAST_ID_KEY, String(id));
  } catch {
    // Storage unavailable — the in-memory cursor still covers this session.
  }
}

function handleEvent(type: string, raw: MessageEvent): void {
  const id = Number(raw.lastEventId);
  if (id > 0) {
    lastEventId = id;
    writeCursor(id);
  }
  let event: WarehouseEvent;
  try {
    event = JSON.parse(raw.data) as WarehouseEvent;
  } catch {
    return; // malformed frame — ignore
  }
  const topics = Array.isArray(event.topics) ? event.topics : [];
  for (const topic of topics) {
    invalidatePrefix(topic);
  }
  for (const sub of [...subscribers]) {
    if (sub.topics.some((t) => topics.includes(t))) {
      sub.cb(event);
    }
  }
  const toast = TOASTS[type];
  if (toast) {
    const i18n = useNuxtApp().$i18n;
    useToast().showToast(i18n.t(toast.key, event.data ?? {}), {
      action: { label: i18n.t("view"), to: toast.to },
    });
  }
}

function connect(): void {
  if (es) return; // already connected/connecting
  // EventSource can't set headers — the JWT rides as a query param. No
  // token, no stream (signed out).
  const token = getToken();
  if (!token) return;
  if (lastEventId === null) lastEventId = readCursor();
  const base = (useRuntimeConfig().public.apiBaseUrl as string).replace(/\/+$/, "");
  const source = new EventSource(
    `${base}/events?since=${lastEventId}&token=${encodeURIComponent(token)}`
  );
  es = source;
  for (const type of KNOWN_EVENT_TYPES) {
    source.addEventListener(type, (ev) => handleEvent(type, ev as MessageEvent));
  }
  source.onopen = () => {
    connected.value = true;
    backoffMs = INITIAL_BACKOFF_MS;
  };
  // Manual reconnect: close, wait with backoff, and reconnect with the
  // persisted ?since= cursor.
  source.onerror = () => {
    source.close();
    if (es === source) es = null;
    connected.value = false;
    if (reconnectTimer === null) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, backoffMs);
      backoffMs = Math.min(backoffMs * BACKOFF_FACTOR, MAX_BACKOFF_MS);
    }
  };
}

function disconnect(): void {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  es?.close();
  es = null;
  connected.value = false;
  lastEventId = null; // re-read the persisted cursor on the next connect
  backoffMs = INITIAL_BACKOFF_MS;
}

function subscribe(topics: string[], cb: WarehouseEventCallback): () => void {
  const sub = { topics, cb };
  subscribers.push(sub);
  return () => {
    const index = subscribers.indexOf(sub);
    if (index !== -1) subscribers.splice(index, 1);
  };
}

export function useWarehouseEvents() {
  return {
    connected: readonly(connected),
    connect,
    disconnect,
    subscribe,
  };
}
