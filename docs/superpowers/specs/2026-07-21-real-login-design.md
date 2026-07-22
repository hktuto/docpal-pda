# Real login — password hashing, user groups, JWT sessions

Date: 2026-07-21
Status: approved, implemented

Replaces the stateless demo auth (plain-text password compare, `users.role`
text column, no tokens, every route open) with real authentication:
scrypt-hashed passwords, many-to-many user groups, and a JWT bearer token
enforced by global middleware.

## Decisions

### JWT bearer token, not cookies

Cookies are effectively unworkable for this deployment: the Capacitor WebView
origin is `http://localhost` (`server.androidScheme: "http"`) while the API is
cross-origin (LAN IP, or `localhost:3002` via adb reverse). Cross-origin
cookies need `SameSite=None; Secure`, and `Secure` requires HTTPS — the
warehouse deployment is plain HTTP on a LAN. A bearer token in the
`Authorization` header sidesteps CORS/SameSite entirely and behaves
identically in browser dev and on device.

**LAN/TLS caveat:** over plain HTTP any token (like any cookie) is sniffable
on the local network. TLS termination (reverse proxy in front of the backend)
is the real fix and is out of scope for this phase.

### Password hashing: scrypt via node:crypto

Zero new dependencies — argon2/bcrypt need native modules (pain on Windows
dev and Vercel). Stored format:

```
scrypt:N:r:p:<salt-hex>:<hash-hex>   (N=16384, r=8, p=1, 64-byte key)
```

Verification uses `timingSafeEqual`. Rows that do not start with `scrypt:`
are treated as legacy plain-text: a successful plain-text login lazily
re-hashes and saves the scrypt form, upgrading old rows in place with no
migration of secrets.

### Groups replace role, many-to-many

`users.role` is dropped. New tables:

- `user_groups` — `code` PK, `label` NOT NULL, `remark`, timestamps.
- `user_group_members` — `(user_id FK → users ON DELETE CASCADE,
  group_code FK → user_groups ON DELETE CASCADE)`, composite PK,
  `created_at`.

The migration seeds `operator`/`admin` groups and converts each existing
user's `role` value into a membership row before dropping the column. The
demo seed: operator → `operator`; admin → `admin` + `operator`. A user can
belong to any number of groups; tokens carry the full `groupCodes` array.

### Enforcement scope

Global Hono middleware requires `Authorization: Bearer <token>` on every
route except:

- `GET /health` (liveness)
- `POST /auth/login`
- `/dev/*` (kept open so the demo reset control keeps working)

`GET /events` additionally accepts `?token=` because `EventSource` cannot set
headers; the query token is accepted **only** on that route.

`actorId` is derived from the token server-side (`c.get("user")`); the
request-body `actorId` field is removed from all mutation DTOs and ignored if
sent.

### Token shape and revocation stance

HS256 JWT signed with `AUTH_SECRET` (env; a dev default is built in and a
startup warning is printed when the env var is unset). TTL env
`AUTH_TOKEN_TTL_SECONDS`, default 43200 (12 h shift). Payload:

```json
{ "sub": "<user id>", "username": "operator", "groupCodes": ["operator"], "exp": 1234567890 }
```

Logout is client-side token discard (`POST /auth/logout` stays a symmetric
no-op). There is no server-side revocation list; if force-logout is needed
later, add `users.token_version` and check it in the middleware. Refresh
tokens are out of scope.

## API

- `POST /auth/login` `{username, password}` →
  `{ user: { id, username, displayName, groupCodes }, token }`
  (401 `invalid credentials` on unknown user / wrong password; legacy
  plain-text rows are upgraded to scrypt on success).
- `GET /auth/me` → the same `user` object, resolved fresh from the DB by
  token `sub` (session restore for clients).
- `GET /auth/users/:id` → same `user` object for any user (now behind auth).
- `POST /auth/change-password` `{oldPassword, newPassword}` → `{ok: true}`
  (self-service; 401 on wrong old password).
- `POST /auth/logout` → `{ok: true}` (no-op).
- Admin: `/admin/users` accepts a write-only `password` (hashed server-side,
  optional on edit = keep current) and never returns `password_hash`;
  `/admin/user-groups` and `/admin/user-group-members` join the generic CRUD
  routers (membership rows addressed as `:userId::groupCode`).

## Out of scope

- TLS / LAN sniffing (see caveat above).
- Token revocation list (`users.token_version`) and refresh tokens.
- ucenter / external user-system sync — the `users` table stays local and
  syncable by `username`.
- Permission matrix beyond carrying group codes (routes authenticate but do
  not yet authorize per group).
