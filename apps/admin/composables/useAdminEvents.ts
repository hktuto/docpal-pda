/**
 * Minimal SSE client for the backend /events stream (admin side).
 * Singleton EventSource, lazy-connected on the first subscribe; listeners are
 * per event type. Auth uses the `?token=` query param (EventSource cannot set
 * headers — /events is the one route that accepts it).
 *
 * Events delivered from the connect-time backlog replay are dropped: listeners
 * only see events created at or after their subscribe call (15 s clock-skew
 * tolerance), so "wait for the next allocation.finished" patterns never
 * resolve against a stale run.
 */
interface AdminEvent {
  id: number;
  type: string;
  topics: string[];
  data: unknown;
  createdDate: string;
}

type Listener = (event: AdminEvent) => void;

const SKEW_MS = 15_000;

let source: EventSource | null = null;
let baseUrl = "";
const listeners = new Map<string, Map<Listener, number>>();
const boundTypes = new Set<string>();

function handleMessage(type: string, msg: MessageEvent) {
  let event: AdminEvent;
  try {
    event = JSON.parse(msg.data);
  } catch {
    return;
  }
  const createdMs = Date.parse(event.createdDate);
  for (const [cb, since] of listeners.get(type) ?? []) {
    if (Number.isFinite(createdMs) && createdMs < since - SKEW_MS) continue;
    cb(event);
  }
}

function bind(type: string) {
  if (!source || boundTypes.has(type)) return;
  boundTypes.add(type);
  source.addEventListener(type, (msg) => handleMessage(type, msg));
}

function connect() {
  if (source || !import.meta.client || !baseUrl) return;
  const token = localStorage.getItem("admin_token");
  if (!token) return;
  source = new EventSource(`${baseUrl}/events?token=${encodeURIComponent(token)}`);
  // Native EventSource auto-reconnects on network errors; a 401 (expired JWT)
  // never succeeds, so tear down and let the next subscribe retry fresh.
  source.onerror = () => {
    if (source?.readyState === EventSource.CLOSED) {
      source = null;
      boundTypes.clear();
      if (listeners.size > 0) setTimeout(connect, 5000);
    }
  };
  for (const type of listeners.keys()) bind(type);
}

export function useAdminEvents() {
  if (!baseUrl) {
    baseUrl = useRuntimeConfig().public.apiBaseUrl as string;
  }

  /** Listen for an event type; returns an unsubscribe function. */
  function subscribe(type: string, cb: Listener): () => void {
    let set = listeners.get(type);
    if (!set) {
      set = new Map();
      listeners.set(type, set);
    }
    set.set(cb, Date.now());
    connect();
    bind(type);
    return () => {
      const s = listeners.get(type);
      s?.delete(cb);
      if (s && s.size === 0) listeners.delete(type);
    };
  }

  return { subscribe };
}
