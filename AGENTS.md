# Agent Instructions

This is a client-side Nuxt 3 proof-of-concept for warehouse mobile/Android flows. It runs a full Postgres database in the browser using PGlite, so the demo works without a backend.

## Tech stack

- **Framework:** Nuxt 3 (`ssr: false`)
- **UI:** Vue 3, plain CSS
- **Database:** PGlite — WebAssembly build of Postgres running in the browser
- **ORM:** Drizzle ORM with the `drizzle-orm/pglite` driver
- **Reactive queries:** `@electric-sql/pglite-vue` (`useLiveQuery`)
- **Persistence:** IndexedDB via PGlite (`idb://warehouse-demo-pglite`)

## Common commands

```bash
pnpm install        # install dependencies
pnpm dev            # start dev server
pnpm nuxt prepare   # generate Nuxt types; run after schema/template changes
pnpm build          # production build
```

## Code conventions

- Follow existing patterns. Make minimal, focused changes.
- Keep files small and single-responsibility.
- Put database helpers in `db/` and Vue composables in `composables/`.
- Use `useLiveQuery` for reactive list pages.
- Inline raw SQL is acceptable for list queries when Drizzle relations are cumbersome.
- Prefer explicit, readable names over clever abstractions.

## Testing

There is no automated test suite yet. Verify work with:

1. `pnpm nuxt prepare` — ensure types generate without errors.
2. Manual browser check — log in as `operator` / `DocPal2026!`, navigate through the affected flows, and confirm behavior.

## Feature workflow

For non-trivial changes:

1. Write a design spec in `docs/superpowers/specs/YYYY-MM-DD-<feature>-design.md`.
2. Write an implementation plan in `docs/superpowers/plans/YYYY-MM-DD-<feature>.md`.
3. Implement, verify, and commit.

## Demo limitations to keep in mind

- **No migrations.** The schema is created once from `db/init.ts` when the `users` table does not exist. Schema changes require clearing IndexedDB.
- **Demo passwords only.** Passwords are stored as plain-text hashes in the seed file.
- **Per-browser database.** PGlite stores data in IndexedDB, so each browser has its own isolated demo database.
- **No camera OCR.** Scanning is typed input; the demo parses and normalizes text to simulate OCR behavior.
