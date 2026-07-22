// JWT sign/verify via Hono's built-in hono/jwt (HS256). Payload:
// { sub: userId, username, groupCodes: string[], exp } — see
// docs/superpowers/specs/2026-07-21-real-login-design.md.

import { sign, verify } from "hono/jwt";
import { authSecret, authTokenTtlSeconds } from "../config.js";

export interface AuthTokenUser {
  id: string;
  username: string;
  groupCodes: string[];
}

export async function signAuthToken(user: AuthTokenUser): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + authTokenTtlSeconds;
  return sign(
    { sub: user.id, username: user.username, groupCodes: user.groupCodes, exp },
    authSecret,
    "HS256"
  );
}

/** Verify signature + exp. Throws (hono/jwt JwtToken*) on any failure. */
export async function verifyAuthToken(token: string): Promise<AuthTokenUser> {
  const payload = await verify(token, authSecret, "HS256");
  if (typeof payload.sub !== "string" || typeof payload.username !== "string") {
    throw new Error("malformed token payload");
  }
  return {
    id: payload.sub,
    username: payload.username,
    groupCodes: Array.isArray(payload.groupCodes)
      ? payload.groupCodes.filter((g): g is string => typeof g === "string")
      : [],
  };
}
