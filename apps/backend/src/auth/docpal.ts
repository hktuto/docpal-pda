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

async function docpalFetch(path: string, init: RequestInit): Promise<Response> {
  const base = docpalBaseUrl();
  if (!base) throw new DocpalAuthError(502, "DOCPAL_URL is not set");
  try {
    return await fetch(`${base}${path}`, {
      ...init,
      signal: AbortSignal.timeout(docpalFetchTimeoutMs),
    });
  } catch {
    throw new DocpalAuthError(502, "DocPal API unreachable");
  }
}

/** POST /auth/login against DocPal → access_token. */
export async function docpalLogin(username: string, password: string): Promise<string> {
  const res = await docpalFetch("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (res.status === 401 || res.status === 403) {
    throw new DocpalAuthError(401, "invalid credentials");
  }
  if (!res.ok) throw new DocpalAuthError(502, `DocPal login failed (${res.status})`);
  // Live API wraps the tokens in the standard envelope ({code, result, data});
  // accept a flat {access_token} body too, per the API doc.
  const body = (await res.json().catch(() => null)) as {
    data?: { access_token?: unknown } | null;
    access_token?: unknown;
  } | null;
  const token = body?.data?.access_token ?? body?.access_token;
  if (typeof token !== "string" || !token) {
    throw new DocpalAuthError(502, "DocPal login returned no access_token");
  }
  return token;
}

/** GET /dms/user/getApplication → normalized profile. */
export async function docpalGetUser(accessToken: string): Promise<DocpalUser> {
  const res = await docpalFetch("/dms/user/getApplication", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 401 || res.status === 403) {
    throw new DocpalAuthError(401, "invalid credentials");
  }
  if (!res.ok) throw new DocpalAuthError(502, `DocPal getApplication failed (${res.status})`);
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
    throw new DocpalAuthError(502, "DocPal getApplication returned an unexpected response");
  }
  const username =
    (typeof data.username === "string" && data.username) ||
    (typeof data.userId === "string" && data.userId) ||
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
