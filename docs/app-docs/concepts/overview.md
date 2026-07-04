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
- **Offline-capable demo.** PGlite stores the database in the browser's IndexedDB.
- **No backend.** All data lives in the browser; this is for demonstration and training only.

## Demo limitations

- **No migrations.** The schema is created once from `db/init.ts`. Schema changes require clearing IndexedDB.
- **Demo passwords only.** Passwords are stored as plain-text hashes in the seed file.
- **Per-browser database.** Each browser/device has its own isolated demo database.
- **Typed scanning.** Camera OCR exists on Android for label capture in some flows, but much scanning is simulated by typed input.
- **No automated test suite.** Verification is manual browser testing plus `pnpm nuxt prepare`.

## Who should read this

- Warehouse operators learning the app.
- Trainers preparing onboarding material.
- AI agents that need a high-level understanding before diving into code.
