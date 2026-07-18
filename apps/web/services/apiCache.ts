/**
 * Client-side SWR cache for GET responses (design:
 * docs/superpowers/specs/2026-07-18-sse-events-and-swr-cache-design.md).
 *
 * In-memory Map mirrored to localStorage under `wms-cache:<url>` so app
 * restarts serve instantly. The 60 s TTL is the correctness floor; ahead of
 * it, server events (useWarehouseEvents) and local mutations (apiClient
 * post/patch/del) invalidate matching URL-path prefixes.
 */

const TTL_MS = 60_000;
const MAX_ENTRIES = 150;
const STORAGE_PREFIX = "wms-cache:";

interface CacheEntry {
  ts: number;
  data: unknown;
}

const memory = new Map<string, CacheEntry>();

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function remove(url: string): void {
  memory.delete(url);
  storage()?.removeItem(STORAGE_PREFIX + url);
}

function readEntry(url: string): CacheEntry | null {
  let entry = memory.get(url);
  if (!entry) {
    const raw = storage()?.getItem(STORAGE_PREFIX + url);
    if (raw) {
      try {
        entry = JSON.parse(raw) as CacheEntry;
        memory.set(url, entry);
      } catch {
        storage()?.removeItem(STORAGE_PREFIX + url);
      }
    }
  }
  if (!entry) return null;
  if (Date.now() - entry.ts > TTL_MS) {
    remove(url); // expired entries are deleted lazily, on access
    return null;
  }
  return entry;
}

/** Cached payload for `url`, or null when missing/expired. */
export function getCached<T = unknown>(url: string): T | null {
  const entry = readEntry(url);
  return entry === null || entry.data === undefined ? null : (entry.data as T);
}

export function setCached(url: string, data: unknown): void {
  const entry: CacheEntry = { ts: Date.now(), data };
  // Re-insert so recency is reflected in insertion order for eviction.
  memory.delete(url);
  memory.set(url, entry);
  try {
    storage()?.setItem(STORAGE_PREFIX + url, JSON.stringify(entry));
  } catch {
    // Quota/serialization failure — the memory copy still serves this session.
  }
  evictOldest();
}

function evictOldest(): void {
  while (memory.size > MAX_ENTRIES) {
    let oldestKey: string | null = null;
    let oldestTs = Infinity;
    for (const [key, entry] of memory) {
      if (entry.ts < oldestTs) {
        oldestTs = entry.ts;
        oldestKey = key;
      }
    }
    if (oldestKey === null) return;
    remove(oldestKey);
  }
}

/** URL path of a cache key (keys are full URLs, possibly with a query). */
function urlPath(url: string): string {
  try {
    return new URL(url, "http://x").pathname;
  } catch {
    return url;
  }
}

/** Cache-key URLs mirrored in localStorage (memory may not have loaded them). */
function storedUrls(): string[] {
  const s = storage();
  if (!s) return [];
  const urls: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const key = s.key(i);
    if (key?.startsWith(STORAGE_PREFIX)) {
      urls.push(key.slice(STORAGE_PREFIX.length));
    }
  }
  return urls;
}

/** Drop every entry whose URL path starts with `prefix` (e.g. "/picking-orders"). */
export function invalidatePrefix(prefix: string): void {
  const urls = new Set([...memory.keys(), ...storedUrls()]);
  for (const url of urls) {
    if (urlPath(url).startsWith(prefix)) {
      remove(url);
    }
  }
}

/** Drop the whole cache: memory plus every `wms-cache:` storage key. */
export function clearApiCache(): void {
  memory.clear();
  for (const url of storedUrls()) {
    storage()?.removeItem(STORAGE_PREFIX + url);
  }
}
