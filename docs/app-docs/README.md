# Warehouse PDA App Documentation

This manual explains the warehouse PDA demo app for **operators and trainers**, and provides a lookup reference for **AI coding agents**.

## Quick links

- [Concepts](./concepts/overview.md) — what the app is, who uses it, and how it is organized.
- [User Menu](./user-menu/index.md) — login and home screen reference.
- [Flows](./flows/index.md) — step-by-step guides for each warehouse operation.
- [Components](./components/shared-components.md) — shared UI building blocks.
- [Composables](./composables/index.md) — reusable Vue logic.
- [Device Setup](./setup/android-pda-scanner.md) — Android PDA scanner configuration.
- [AI Feature Registry](./ai/feature-registry.md) — machine-readable feature index for agents.

## For operators and trainers

Start with [Concepts → Overview](./concepts/overview.md) and the [User Menu](./user-menu/index.md), then follow the flow you need:

1. [Picking](./flows/picking/overview.md)
2. [Receiving](./flows/receiving/overview.md)
3. [Put-away](./flows/put-away/overview.md)
4. [Measuring](./flows/measuring/overview.md)
5. [Goods verify](./flows/goods-verify/overview.md)
6. [Stock Search](./flows/stock-search/overview.md)

## For AI agents

- Use [feature-registry.md](./ai/feature-registry.md) to find which files implement a feature.
- Use each flow's `ai-scope.md` to understand boundaries and limitations.
- Use [code-map.md](./ai/code-map.md) for page/component ↔ source-file mappings.

## Project references

- [Root README](../../README.md) — setup and quick-start.
- [AGENTS.md](../../AGENTS.md) — coding conventions and commands.
- [Database relations](../database-relations.md) — ER diagram and table summary.
- [Design specs](../superpowers/specs/) — per-feature design documents.
