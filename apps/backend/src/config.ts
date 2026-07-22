// Auth configuration (spec: docs/superpowers/specs/2026-07-21-real-login-design.md).

// Secret used to sign/verify HS256 JWTs. Set AUTH_SECRET in any real
// deployment; the built-in default keeps local dev zero-config.
const DEV_AUTH_SECRET = "warehouse-dev-only-insecure-auth-secret";

export const authSecret = process.env.AUTH_SECRET ?? DEV_AUTH_SECRET;

if (!process.env.AUTH_SECRET) {
  console.warn("[auth] AUTH_SECRET is not set — using the built-in dev secret. Do not use in production.");
}

// Token TTL in seconds; default 43200 = 12 h (one warehouse shift).
export const authTokenTtlSeconds = Number(process.env.AUTH_TOKEN_TTL_SECONDS ?? 43200);
