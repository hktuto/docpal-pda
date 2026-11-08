import { useFlowApi } from "~/utils/flowApi";

// Batch parts-master existence/brand check with a module-level cache (spec
// docs/superpowers/specs/2026-11-08-receiving-cn-excel-local-upload-design.md).
// The CN excel verify table mounts one part-no combobox per item row (1xx+
// rows) and the upload gate validates every key — per-instance queries would
// storm POST /admin/parts-lookup one row at a time. Callers ensure() the keys
// they care about; the queue flushes as ONE debounced, chunked request and
// results stay cached for the app session, so re-uploads/re-edits only
// re-query values nobody has checked yet.

export interface PartsCheckResult {
  found: boolean;
  brand: string | null;
}

const cache = reactive(new Map<string, PartsCheckResult>());
const queue = new Set<string>();
const waiters: ((failed: boolean) => void)[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;
const FLUSH_MS = 150;
const CHUNK = 400;

// Dedup key: trim, collapse inner whitespace, lower. The server's
// normalizePartNo (strip-space + upper + TE-AMP unwrap) is the matching
// authority; this only avoids re-sending the same visible string.
function cacheKey(key: string): string {
  return key.trim().replace(/\s+/g, " ").toLowerCase();
}

export function usePartsBrandCheck() {
  const flow = useFlowApi();

  async function flush() {
    flushTimer = undefined;
    const todo = [...queue];
    queue.clear();
    const resolve = waiters.splice(0, waiters.length);
    let failed = false;
    try {
      for (let i = 0; i < todo.length; i += CHUNK) {
        const { matches } = await flow.checkParts(todo.slice(i, i + CHUNK));
        for (const m of matches) cache.set(cacheKey(m.key), { found: m.found, brand: m.brand });
      }
    } catch {
      // Network/server failure — keys stay uncached, callers decide (never
      // flag a value unknown on a failed check).
      failed = true;
    }
    for (const w of resolve) w(failed);
  }

  /** Queue the not-yet-cached keys; resolves when the batch carrying them
   *  finished (true = the check failed). Already-cached keys resolve now. */
  function ensure(keys: string[]): Promise<boolean> {
    const todo = keys.filter((k) => k.trim() !== "" && !cache.has(cacheKey(k)));
    if (todo.length === 0) return Promise.resolve(false);
    for (const k of todo) queue.add(k);
    if (flushTimer === undefined) flushTimer = setTimeout(flush, FLUSH_MS);
    return new Promise<boolean>((resolve) => waiters.push(resolve));
  }

  /** Cached check result — undefined until the batch resolved. */
  function check(key: string): PartsCheckResult | undefined {
    return cache.get(cacheKey(key));
  }

  /** Brand of a uniquely-matched master row; undefined = unchecked,
   *  null = unknown/ambiguous. */
  function brandOf(key: string): string | null | undefined {
    const c = check(key);
    return c === undefined ? undefined : c.found ? c.brand : null;
  }

  return { ensure, check, brandOf };
}
