# Token login link — design (2026-09-11)

## Problem

We want a shareable link that opens the admin console already signed in as a
given user — e.g. a "Open warehouse admin" entry point inside DocPal that
carries the current user's identity, with no password prompt.

The token such a link can realistically carry is the **DocPal access token**
(ES256, `kid: docpal.v1`, ~2 h TTL) — not the warehouse backend's own JWT
(HS256, `AUTH_SECRET`, 12 h TTL), which only exists after a warehouse login.

## Design

Two parts:

1. **Backend: `POST /auth/login-token`** (open route, added to the auth
   middleware allowlist next to `/auth/login`). Body `{accessToken}`. The
   token is validated by calling DocPal `GET /apis/v1/ucenter/users/application`
   (`docpalGetUser`) — the same identity check the password login performs
   after `docpalLogin`. On success the profile goes through the exact same
   provisioning path (`provisionAndSign` in `src/routes/auth.ts`): group
   mapping via `docpalGroupMapping` (403 when nothing maps), local `users`
   upsert, group-membership replacement, and a freshly signed warehouse JWT.
   Responses mirror `/auth/login`: 200 `{user, token}` / 400 missing
   accessToken / 401 bad token / 403 no WMS access / 500 no `DOCPAL_URL` /
   502 provider unreachable.

   Security posture is identical to password login: DocPal remains the only
   credential verifier, and possession of a DocPal access token is equivalent
   to being logged in at DocPal. The issued warehouse JWT is a normal
   12 h session.

2. **Admin: `pages/login-token.vue`**. Reads the token from the URL fragment
   `#token=` (preferred — fragments are never sent to servers, logged, or
   leaked via `Referer`) or the `?token=` query, immediately strips it from
   the URL via `history.replaceState`, exchanges it at `POST /auth/login-token`,
   enforces the same `admin` group requirement as the password login, stores
   `admin_token`/`admin_user` in localStorage, and lands on `/`. Failures show
   a localized error (`admin.auth.invalidOrExpiredLink` /
   `admin.auth.noAdminAccess`) with a back-to-sign-in link. The route is
   whitelisted in `middleware/auth.global.ts` so the guard doesn't redirect
   before the exchange runs (and so a link for a different user is honored
   even when a session already exists).

## Link format

```
https://<admin-host>/login-token#token=<docpal-access-token>
```

## Non-goals / notes

- No server-side token minting: the link carries a live DocPal session token,
  so link lifetime equals the DocPal token TTL (~2 h). A "generate link for
  another user" admin feature would need a separate minting endpoint.
- No revocation: discarding the link does not invalidate the token; DocPal
  session expiry is the bound.
- The PDA web app is unchanged (no token-login page there).
