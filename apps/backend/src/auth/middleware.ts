// Global auth middleware (registered in src/index.ts): every route requires
// `Authorization: Bearer <jwt>` except the allowlist below. On success the
// token user is stored as c.get("user"); failures are 401 `unauthorized`.
// `?token=` is accepted ONLY for GET /events because EventSource cannot set
// headers.

import type { Context, MiddlewareHandler, Next } from "hono";
import { HTTPException } from "hono/http-exception";
import { verifyAuthToken, type AuthTokenUser } from "./jwt.js";

export interface AuthVariables {
  user: AuthTokenUser;
}

function isOpenPath(path: string, method: string): boolean {
  if (path === "/health") return true;
  if (path === "/auth/login" && method === "POST") return true;
  if (path.startsWith("/dev/")) return true; // demo reset stays open
  return false;
}

export const authMiddleware: MiddlewareHandler<{ Variables: AuthVariables }> = async (
  c: Context<{ Variables: AuthVariables }>,
  next: Next
) => {
  const path = c.req.path;
  if (isOpenPath(path, c.req.method)) return next();

  let token: string | undefined;
  const header = c.req.header("authorization");
  if (header?.startsWith("Bearer ")) token = header.slice("Bearer ".length).trim() || undefined;
  if (!token && c.req.method === "GET" && path === "/events") {
    token = c.req.query("token");
  }
  if (token) {
    try {
      c.set("user", await verifyAuthToken(token));
      return next();
    } catch {
      // fall through to 401
    }
  }
  throw new HTTPException(401, { message: "unauthorized" });
};

/** The authenticated user (set by authMiddleware on every non-open route). */
export function actorFrom(c: Context): AuthTokenUser {
  return (c as unknown as Context<{ Variables: AuthVariables }>).get("user");
}
