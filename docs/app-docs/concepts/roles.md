# Roles and Login

## User role

PDA operators share one uniform UI — there is no per-role screen split — but each operator's queues are scoped by **assignee**: PDA queue tables carry a nullable `assignee` username, the backend returns only rows assigned to the logged-in user plus unassigned rows (`apps/backend/src/db/user-scope.ts`, `assigneeFilter`), and the PDA badges the rows naming you with "Assigned to me" (`composables/useAssignedToMe.ts`). Assignments are managed in the admin console (`GET /admin/task-assignments` / `PATCH /admin/task-assignment`). Access is otherwise group-based (`user_groups`): only members of the **admin** group can log into the desktop admin console (`apps/admin`).

## Login

Login always delegates to the DocPal API — the backend stores no passwords (`apps/backend/src/auth/docpal.ts`). A successful DocPal login mints the local JWT, auto-provisions the user, and maps DocPal groups to local groups (**admin** / **PDA Group**) via `docpalGroupMapping` in `apps/backend/src/config.ts`.

In the dev/demo world (local fake DocPal):

1. Open the app.
2. Enter username `operator`.
3. Enter password `DocPal2026!` (a dev-fake-only demo password).
4. Tap **Login**.

Real deployments use the users' own DocPal accounts (`DOCPAL_URL`).

## After login

The app shows the home screen with the main menu. Use the menu to choose a warehouse flow.

## Language

Operators can switch language using the language switcher in the app header. Supported languages are configured in `layers/i18n/i18n/config.ts` and live under `layers/i18n/i18n/locales/` (shared Nuxt layer).
