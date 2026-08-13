# DocPal-backed authentication (external identity provider)

Date: 2026-08-13
Status: approved, implemented

Delegates login to the DocPal API (`DOCPAL_URL`) instead of verifying local
scrypt passwords, while keeping the local `users` table as the identity
record the rest of the system keys off (`actor.id` from our JWT is stamped
into mutation bodies / `transaction_logs` / work locks / FK references in ~95
places). The backend keeps issuing its own HS256 JWT — the DocPal tokens are
used only inside the login call and never leave it.

## Flow

```
PDA/admin → POST /auth/login {username, password}
  backend → POST {DOCPAL_URL}/auth/login           → {access_token, ...}
  backend → GET  {DOCPAL_URL}/dms/user/getApplication (Bearer access_token)
          → {code: 200, result: true, data: {username, firstName, lastName,
               aclUserDetail: {groups: [{groupId, groupName}]}}}
  backend upserts local users row + syncs groups (one transaction)
  backend signs its own JWT → {user, token} (response shape unchanged)
```

## Decisions

### Config gate: `DOCPAL_URL`

- Set → login is DocPal-only; local password login is bypassed entirely.
  User/group management lives in DocPal: there is no admin user/group CRUD
  (`/admin/users`, `/admin/user-groups`, `/admin/user-group-members` were
  removed) and no `/auth/change-password` — a locally-created user could
  never log in and local group edits would be overwritten at the next DocPal
  login.
- Unset → the existing local scrypt login (with legacy plaintext upgrade)
  stays for the seeded demo accounts. Dev, the demo seeds, and the whole test
  suite run this way.

### Auto-provision local users

Any valid DocPal user can log in. On first login a local `users` row is
created (`newId()`, `password_hash = ""` — an empty sentinel that can never
verify: empty passwords are rejected before any compare); on later logins the
row's `display_name` is refreshed and the `id` is preserved so historical
`actor_id` references stay stable.

### DocPal groups map to local groups (permissions enforced server-side)

The DocPal API returns groups, not the permission column — but DocPal has
"1 group = 1 role" and the role carries the permissions (UAT credentials
sheet), so `docpalGroupMapping` in `src/config.ts` maps DocPal groupIds to
local group codes:

| DocPal group | DocPal permissions | Local codes |
|---|---|---|
| `administrators` (Administrators Group) | full control | `admin`, `operator` |
| `WMS_Admin_Group_(HK)` | WMS Admin: Full Access + PDA | `admin`, `operator` |
| `WMS_PDA_Group_(HK)` | PDA: Full Access | `operator` |
| `WMS_Dashboard_Group_(HK)`, `MCI_MCE_Group_(HK)`, `HK_TH_Group_(HK)` | dashboard / email only | — (none) |

The mapped local codes become the token's `groupCodes`; the user's
`user_group_members` is *replaced* with them on every login (`admin`/
`operator` `user_groups` rows are upserted as needed). A user whose DocPal
groups map to nothing is rejected at login with **403 `user has no WMS
access`** — no token, no local row — because our JWT would otherwise grant
API access to dashboard-only users.

Enforcement per surface: the PDA web app is covered by the 403 at login; the
admin console additionally gates on `groupCodes.includes("admin")`
client-side, which now works because the mapping grants `admin` only to
`WMS_Admin_Group_(HK)` / `administrators` members.

### Failure modes

- DocPal 401 on login → 401 `invalid credentials` (indistinguishable from a
  local bad login, by design).
- DocPal unreachable / timeout (10 s) / 5xx / malformed response → 502
  `identity provider unavailable`.

### Out of scope

- DocPal `refresh_token` handling or token passthrough — our own JWT remains
  the session token (12 h TTL).
- Removing the local login code path or the `users` table.
