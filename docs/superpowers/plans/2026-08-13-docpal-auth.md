# DocPal-backed authentication — implementation plan

Date: 2026-08-13
Spec: `docs/superpowers/specs/2026-08-13-docpal-auth-design.md`

1. `apps/backend/src/config.ts` — add `docpalBaseUrl()` (reads
   `process.env.DOCPAL_URL` at call time so tests can toggle it; trims the
   trailing slash) and a 10 s fetch-timeout constant.
2. `apps/backend/src/auth/docpal.ts` (new) — `docpalLogin(username, password)`
   → access token; `docpalGetUser(accessToken)` →
   `{username, displayName, groups: [{id, name}]}`; `DocpalAuthError` with
   `status` (401 vs 502). Global `fetch` + `AbortSignal.timeout`.
3. `apps/backend/src/routes/auth.ts` — when `docpalBaseUrl()` is set:
   `/auth/login` runs the DocPal flow (login → getApplication → users upsert +
   group replace in one transaction → sign our JWT); `/auth/change-password`
   returns 400. Local scrypt path stays as the `else` branch.
4. `apps/backend/src/auth/auth.test.ts` — DocPal block with a `node:http`
   fake DocPal server: happy path (row created, `password_hash = ""`, id
   stable across logins, display name refreshed, groups replaced), 401, 502,
   change-password 400.
5. Docs: `AGENTS.md` auth bullet, `docs/app-docs/` auth flow files,
   `docker-compose.prod.yml` backend env passthrough.

Verify: `pnpm --filter @warehouse/backend test` + `build`; manual curl login
against DocPal UAT, then `GET /auth/me`.
