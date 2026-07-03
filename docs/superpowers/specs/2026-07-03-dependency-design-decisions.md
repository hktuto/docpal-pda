# Dependency Design Decisions

> Date: 2026-07-03  
> Scope: Demo / proof-of-concept only

## Keep `uuid` instead of switching to `crypto.randomUUID()`

**Decision:** Continue using the `uuid` package for ID generation; do not replace it with the platform-native `crypto.randomUUID()`.

**Rationale:**

- This project is a client-side demo running inside a Capacitor Android WebView. Cross-platform crypto availability in older Android WebViews and in PGlite's WebAssembly worker context is not guaranteed, and verifying compatibility across devices is not worth the effort for a throwaway demo.
- The data-access and seeding layers are expected to be rewritten when the demo is promoted to a real backend. Replacing `uuid` now would be throwaway work.
- The dependency is small, well-understood, and already installed. Removing it saves one package but introduces a risk that is out of proportion for a demo.

**Consequence:** `uuid` remains in `package.json` and is used in `db/seed.ts`, `db/picking.ts`, `db/receiving.ts`, `db/putAway.ts`, `db/measuring.ts`, and `db/allocate.ts`.
