// DocPal identity-provider client (spec: docs/superpowers/specs/2026-08-13-docpal-auth-design.md).
// Used only inside POST /auth/login when DOCPAL_URL is set: verify the
// credentials against DocPal, then fetch the user's profile + groups. DocPal
// tokens never leave this module — the backend issues its own JWT.

import { docpalBaseUrl, docpalFetchTimeoutMs } from "../config.js";

export interface DocpalUser {
  username: string;
  displayName: string;
  groups: { id: string; name: string }[];
}

/** Login/profile failure. `status` is what /auth/login should answer: 401 for
 *  bad credentials, 502 for provider unreachable/misbehaving. */
export class DocpalAuthError extends Error {
  constructor(
    public readonly status: 401 | 502,
    message: string
  ) {
    super(message);
  }
}

/** Render an undici fetch failure with the OS-level reason from `cause`
 *  (ENOTFOUND / ECONNREFUSED / ETIMEDOUT / CERT_* / TimeoutError...). */
function describeFetchError(err: unknown): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } } | null;
  const parts = [e?.name, e?.cause?.code, e?.cause?.message ?? e?.message].filter(Boolean);
  return parts.join(": ") || String(err);
}

async function docpalFetch(path: string, init: RequestInit): Promise<Response> {
  const base = docpalBaseUrl();
  if (!base) throw new DocpalAuthError(502, "DOCPAL_URL is not set");
  const url = `${base}${path}`;
  const method = init.method ?? "GET";
  const started = Date.now();
  try {
    const res = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(docpalFetchTimeoutMs),
    });
    console.log(`[docpal] ${method} ${url} -> ${res.status} in ${Date.now() - started}ms`);
    return res;
  } catch (err) {
    const detail = describeFetchError(err);
    console.error(`[docpal] ${method} ${url} failed after ${Date.now() - started}ms: ${detail}`);
    throw new DocpalAuthError(502, `DocPal API unreachable (${detail})`);
  }
}

/** Boot-time reachability probe (fire-and-forget from server.ts). GETs the
 *  DOCPAL_URL base and logs the outcome: any HTTP status (even 404/405) proves
 *  the container can reach DocPal; a throw logs the OS-level reason
 *  (ENOTFOUND / ECONNREFUSED / ETIMEDOUT / CERT_* ...) so a broken container →
 *  DocPal link is visible in the log before the first login attempt. */
export async function logDocpalConnectivity(): Promise<void> {
  const base = docpalBaseUrl();
  if (!base) return;
  const started = Date.now();
  try {
    const res = await fetch(base, { signal: AbortSignal.timeout(docpalFetchTimeoutMs) });
    console.log(`[docpal] connectivity check: GET ${base} -> HTTP ${res.status} in ${Date.now() - started}ms (reachable)`);
  } catch (err) {
    console.error(`[docpal] connectivity check: GET ${base} FAILED after ${Date.now() - started}ms: ${describeFetchError(err)}`);
  }
}

/** POST /apis/v1/ucenter/auth/login against DocPal → access_token. */
export async function docpalLogin(username: string, password: string): Promise<string> {
  const res = await docpalFetch("/apis/v1/ucenter/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password, serviceId: "docpal", rememberMe: true }),
  });
  if (res.status === 401 || res.status === 403) {
    throw new DocpalAuthError(401, "invalid credentials");
  }
  if (!res.ok) {
    const snippet = await res.text().catch(() => "");
    console.error(`[docpal] login rejected with ${res.status}: ${snippet.slice(0, 300)}`);
    throw new DocpalAuthError(502, `DocPal login failed (${res.status})`);
  }
  // Live API wraps the tokens in the standard envelope ({code, result, data});
  // accept a flat {access_token} body too, per the API doc.
  const body = (await res.json().catch(() => null)) as {
    data?: { access_token?: unknown } | null;
    access_token?: unknown;
  } | null;
  const token = body?.data?.access_token ?? body?.access_token;
  if (typeof token !== "string" || !token) {
    console.error(`[docpal] login 200 but no access_token; body: ${JSON.stringify(body)?.slice(0, 300)}`);
    throw new DocpalAuthError(502, "DocPal login returned no access_token");
  }
  return token;
}

/** GET /apis/v1/ucenter/users/application → normalized profile. */
export async function docpalGetUser(accessToken: string): Promise<DocpalUser> {
  const res = await docpalFetch("/apis/v1/ucenter/users/application", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 401 || res.status === 403) {
    throw new DocpalAuthError(401, "invalid credentials");
  }
  if (!res.ok) {
    const snippet = await res.text().catch(() => "");
    console.error(`[docpal] getApplication rejected with ${res.status}: ${snippet.slice(0, 300)}`);
    throw new DocpalAuthError(502, `DocPal getApplication failed (${res.status})`);
  }
  const body = (await res.json().catch(() => null)) as {
    code?: unknown;
    result?: unknown;
    data?: {
      username?: unknown;
      userId?: unknown;
      firstName?: unknown;
      lastName?: unknown;
      aclUserDetail?: { groups?: { groupId?: unknown; groupName?: unknown }[] } | null;
    } | null;
  } | null;
  const data = body?.data;
  if (!body || body.result !== true || body.code !== 200 || !data) {
    // Log the envelope shape only — the payload carries user PII.
    console.error(
      `[docpal] getApplication unexpected envelope: code=${JSON.stringify(body?.code)} result=${JSON.stringify(body?.result)} hasData=${data != null}`
    );
    throw new DocpalAuthError(502, "DocPal getApplication returned an unexpected response");
  }
  // The new ucenter API returns the display name in `username`; the login
  // identity lives in `userId`, so prefer it for the local users row.
  const username =
    (typeof data.userId === "string" && data.userId) ||
    (typeof data.username === "string" && data.username) ||
    "";
  if (!username) throw new DocpalAuthError(502, "DocPal profile has no username");
  const name = [data.firstName, data.lastName]
    .filter((p): p is string => typeof p === "string" && p.length > 0)
    .join(" ");
  const rawGroups = data.aclUserDetail?.groups;
  const groups = (Array.isArray(rawGroups) ? rawGroups : [])
    .filter((g): g is { groupId: string; groupName?: unknown } => typeof g?.groupId === "string" && g.groupId.length > 0)
    .map((g) => ({ id: g.groupId, name: typeof g.groupName === "string" ? g.groupName : g.groupId }));
  return { username, displayName: name || username, groups };
}
