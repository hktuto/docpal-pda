# Customer Profiles from `customer_accounts` — Design (2026-09-10)

## Goal

Rework the admin "Customer Profiles" pages to mirror the existing Supplier
Profiles UX (list page + per-row profile editor), but source the list from the
new upstream-synced master table `customer_accounts` instead of a locally
maintained entity.

## Data source and soft link

- **Master:** `customer_accounts` (schema `master.ts`) — synced from upstream,
  read-only in the PDA admin console. Business columns: `cust_account_id` (PK),
  `party_id`, `party_name`, `party_type`, `account_number`, `account_status`
  (`A` = Active, `I` = Inactive).
- **Profile:** `customer_profiles` (`code`, `label`, `rule`, `remark`) — PDA-local,
  CRUD via the existing `/admin/customer-profiles` CRUD router (pk = `code`).
- **Link rule:** `customer_profiles.code === customer_accounts.party_name`.
  This is a deliberate *soft link* — the FK from `code` to `customer_accounts`
  was removed during design and must **not** be re-added. A profile can only be
  created for a party name that exists in the synced master, enforced by the UI
  (the editor is disabled when the account is missing), not by the database.

## Backend

New read-only route in `apps/backend/src/routes/admin/index.ts`:

- `GET /admin/customer-accounts` → `CustomerAccount[]` ordered by `party_name`
  asc. Query params:
  - `?q=` — ilike search across `party_name` / `account_number`.
  - `?partyName=` — exact filter on `party_name` (the detail page loads one
    account this way).
- No POST/PATCH/DELETE — data arrives via upstream sync. JWT bearer auth comes
  from the global middleware, same as the rest of `/admin/*`.

Row JSON is Drizzle's camelCase mapping:
`{ custAccountId, partyId, partyName, partyType, accountNumber, accountStatus, lastUpdateDate }`.

## Admin UX (`apps/admin`)

- `pages/customer-profiles/index.vue` — bespoke read-only table (CrudTable
  cannot suppress its create/edit/delete buttons) listing accounts with columns
  ID / Customer Name (`partyName`) / Customer Code (`accountNumber`) /
  Status (`accountStatus` rendered as an Active/Inactive badge). Also fetches
  `GET /admin/customer-profiles`; the row action shows **Edit profile** vs
  **Create profile** (tooltip = profile label or "No profile yet") and
  navigates to `/customer-profiles/<partyName>` (URL-encoded). Client-side
  keyword filter over the fetched rows; sorting/paging via the shared
  `useAdminTable`/`DataTable`/`Pager` primitives.
- `pages/customer-profiles/[partyName].vue` — loads the account via
  `?partyName=`, the matching profile via `/admin/customer-profiles`
  (`code === partyName`). Shows account info read-only; editable form with
  `label` (required), `rule`, `remark`. Save = `PATCH /admin/customer-profiles/<code>`
  when the profile exists, else `POST /admin/customer-profiles` with
  `code = partyName`; then navigate back to `/customer-profiles`.
- The old `customer-profiles` entity config is removed from
  `utils/entities.ts` (no page uses CrudTable for it anymore); the nav entry at
  `/customer-profiles` is unchanged.
- i18n keys under `admin.pages.customerProfiles.*` /
  `admin.pages.customerProfile.*` in `layers/i18n` locales (en-US, zh-CN,
  zh-HK).
