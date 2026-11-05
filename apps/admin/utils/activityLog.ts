// Client-side activity ring buffer for the in-app bug report (spec
// docs/superpowers/specs/2026-11-05-in-app-bug-report-design.md). Copy of
// apps/pda/utils/activityLog.ts (apps share no code except the i18n layer);
// pushed from utils/api.ts + the app.vue route/error wiring only.
//
// shortcut: the buffer lives in sessionStorage, so it survives Vue errors
// and reloads but NOT a browser tab close. Upgrade path: share the module
// through a Nuxt layer if PDA and admin ever need identical semantics.

export type TrailKind = "api" | "scan" | "route" | "error";

export interface TrailEntry {
  t: number; // epoch ms
  k: TrailKind;
  m: string; // human-readable one-liner
  r: string; // route when the entry was emitted
}

const MAX_ENTRIES = 150;
const MAX_BYTES = 40_000;
const TRAIL_KEY = "bug-trail";
const SESSION_KEY = "bug-session-id";

let buffer: TrailEntry[] = [];
try {
  const raw = sessionStorage.getItem(TRAIL_KEY);
  if (raw) buffer = JSON.parse(raw) as TrailEntry[];
} catch {
  // Storage unavailable or corrupt — start fresh.
}

let currentRoute = "";

function mirror() {
  try {
    sessionStorage.setItem(TRAIL_KEY, JSON.stringify(buffer));
  } catch {
    // storage full/blocked — in-memory trail is still submit-able.
  }
}

/** Append one trail entry; caps at MAX_ENTRIES / MAX_BYTES (drops oldest). */
export function pushLog(kind: TrailKind, message: string): void {
  buffer.push({ t: Date.now(), k: kind, m: message.slice(0, 300), r: currentRoute });
  let size = JSON.stringify(buffer).length;
  while (buffer.length > MAX_ENTRIES || (size > MAX_BYTES && buffer.length > 1)) {
    buffer.shift();
    size = JSON.stringify(buffer).length;
  }
  mirror();
}

/** The app.vue router.afterEach keeps route context fresh for every entry. */
export function setLoggedRoute(path: string): void {
  currentRoute = path;
}

/** Snapshot for the report payload. */
export function getTrail(): TrailEntry[] {
  return [...buffer];
}

/** One id per app session — correlates a report's trail with server-side
 *  transaction_logs (username + timestamp window). */
export function getSessionId(): string {
  try {
    let id = sessionStorage.getItem(SESSION_KEY);
    if (!id) {
      id = crypto.randomUUID();
      sessionStorage.setItem(SESSION_KEY, id);
    }
    return id;
  } catch {
    return "unknown";
  }
}
