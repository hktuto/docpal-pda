# @warehouse/api — RETIRED

> **Retired (2026-07).** This package is superseded by `apps/backend`
> (`@warehouse/backend`), which implements the revised WMS schema and a
> redesigned API (see `docs/backend/` — `api-design.md`, plus
> `api-review-old-api.md` for the design review of this package).
>
> The web client (`apps/web`) has switched to the new backend (:3002); this
> package no longer serves any client. It is kept for history only — do not
> add endpoints, fixes, or new work here.
>
> One piece is still shared: the Docker Compose PostgreSQL service in this
> directory (`docker compose up -d`) is the database the new backend (and
> its tests) run against.

The rest of this package's behavior is documented in older revisions of the
root `AGENTS.md` (Hono API on :3001, PostgreSQL via `DATABASE_URL`, Drizzle
migrations auto-applied on startup, `POST /dev/reset` to re-seed).
