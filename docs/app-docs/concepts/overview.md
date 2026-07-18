# Overview

The Warehouse PDA app is a Nuxt 3 proof-of-concept for warehouse mobile/Android flows. It is a thin client: all data lives in the `apps/backend` PostgreSQL backend, which the app talks to over HTTP.

## What it demonstrates

- Receiving incoming shipments.
- Putting received goods away onto shelves.
- Picking items for outgoing orders.
- Measuring and packing shipping boxes.
- Verifying goods during the process.

## Key design ideas

- **Mobile-first.** The UI is built for a handheld Android device.
- **Thin client over HTTP.** Pages call `WarehouseService`, which talks to the `apps/backend` Hono API (default `http://localhost:3002`). All business rules and data live server-side.
- **Persistent demo dataset.** Data is stored in PostgreSQL and survives reloads; a demo reset (`POST /dev/reset`) re-seeds it.

## Demo limitations

- **Demo passwords only.** Passwords are stored as plain-text hashes in the seed file; there are no tokens or sessions.
- **Typed scanning.** Camera OCR exists on Android for label capture in some flows, but much scanning is simulated by typed input.
- **Single shared dataset.** Everyone using the demo works on the same backend database; use the reset control to start fresh.

## Who should read this

- Warehouse operators learning the app.
- Trainers preparing onboarding material.
- AI agents that need a high-level understanding before diving into code.
