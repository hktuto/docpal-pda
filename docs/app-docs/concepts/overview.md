# Overview

The Warehouse PDA app is a Nuxt 3 proof-of-concept for warehouse mobile/Android flows. It is a thin client: all data lives in the `apps/backend` PostgreSQL backend, which the app talks to over HTTP.

## What it demonstrates

- Receiving incoming shipments.
- Putting received goods away onto shelves.
- Picking items for outgoing orders.
- Measuring and packing shipping boxes.
- Verifying packed boxes a second time before shipping.
- Verifying goods during the process (goods verify).

Individual flow steps (e.g. measuring, verify) can be turned on/off per warehouse via the backend `warehouse_config` row `"flow"` (JSON; `FLOW_CONFIG` env override; legacy `FLOW_STEPS_DISABLED` comma-list still works, deprecated) — hidden steps are skipped in the flow chain and their home tiles disappear. `steps.picking.allocation.allowDockStock=false` requires received stock to be put away before it can allocate to picking.

## Key design ideas

- **Mobile-first.** The UI is built for a handheld Android device.
- **Thin client over HTTP.** Pages call `WarehouseService`, which talks to the `apps/backend` Hono API (default `http://127.0.0.1:3002` — `127.0.0.1`, not `localhost`, because some device WebViews can't resolve `localhost`; override via `NUXT_PUBLIC_API_BASE_URL`). All business rules and data live server-side.
- **Persistent demo dataset.** Data is stored in PostgreSQL and survives reloads; a demo reset (`db:seed` CLI) re-seeds it.

## Demo limitations

- **Demo passwords only.** There is no local password auth (no scrypt): login *always* delegates to the DocPal API (`apps/backend/src/auth/docpal.ts`). The seeded demo users (`operator`, `admin`) work against the local test/dev fake DocPal with well-known demo passwords; real deployments authenticate against the real DocPal (`DOCPAL_URL`). Sessions are JWT-based against the backend.
- **Typed scanning.** Camera OCR exists on Android for label capture in some flows, but much scanning is simulated by typed input.
- **Single shared dataset.** Everyone using the demo works on the same backend database; start fresh with the `db:seed` CLI reset (the `POST /dev/reset` endpoint was removed 2026-11-06).

## Who should read this

- Warehouse operators learning the app.
- Trainers preparing onboarding material.
- AI agents that need a high-level understanding before diving into code.
