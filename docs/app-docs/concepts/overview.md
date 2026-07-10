# Overview

The Warehouse PDA app is a client-side Nuxt 3 proof-of-concept for warehouse mobile/Android flows. It runs a full Postgres database in the browser using PGlite, so the demo works without a backend.

## What it demonstrates

- Receiving incoming shipments.
- Putting received goods away onto shelves.
- Picking items for outgoing orders.
- Measuring and packing shipping boxes.
- Verifying goods during the process.

## Key design ideas

- **Mobile-first.** The UI is built for a handheld Android device.
- **Offline-capable demo.** PGlite runs a full Postgres database in the browser, but data is kept in memory only and is re-seeded on each launch.
- **No backend.** All data lives in the browser; this is for demonstration and training only.

## Demo limitations

- **No migrations.** The schema is created once from `db/init.ts`. Because the database is in-memory, schema changes take effect on the next app launch.
- **Demo passwords only.** Passwords are stored as plain-text hashes in the seed file.
- **Data is not persisted.** The in-memory database is re-seeded on every app launch, so each session starts fresh.
- **Typed scanning.** Camera OCR exists on Android for label capture in some flows, but much scanning is simulated by typed input.
- **No automated test suite.** Verification is manual browser testing plus `pnpm nuxt prepare`.

## Who should read this

- Warehouse operators learning the app.
- Trainers preparing onboarding material.
- AI agents that need a high-level understanding before diving into code.
