# Roles and Login

## User role

PDA operators share a single operator login; there is no per-role UI split in the PDA app. Access is group-based (`user_groups`): only members of the **admin** group can log into the desktop admin console (`apps/admin`).

## Login

1. Open the app.
2. Enter username `operator`.
3. Enter password `DocPal2026!`.
4. Tap **Login**.

## After login

The app shows the home screen with the main menu. Use the menu to choose a warehouse flow.

## Language

Operators can switch language using the language switcher in the app header. Supported languages are configured in `layers/i18n/i18n/config.ts` and live under `layers/i18n/i18n/locales/` (shared Nuxt layer).
