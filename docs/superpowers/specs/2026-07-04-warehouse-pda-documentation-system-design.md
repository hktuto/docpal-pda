# Warehouse PDA Documentation System Design

> **Status:** Draft — awaiting review.
>
> **Goal:** Create a proper, discoverable documentation system inside `docs/app-docs/` that serves two audiences: (1) warehouse operators and trainers who need a training manual, and (2) AI coding agents who need a feature lookup table and explicit scope remarks.
>
> **Scope:** Document only what exists today in the demo app. Do not cover in-flight or planned features unless they are already shipped.

---

## 1. Problem Statement

The repository already has:

- `README.md` — project overview and quick-start.
- `docs/database-relations.md` and `docs/database-schema-backend.md` — data-model references.
- `AGENTS.md` — coding-agent instructions.
- `docs/superpowers/specs/` and `docs/superpowers/plans/` — design specs and implementation plans for individual features.

What is missing is a **single, structured user-and-agent manual** that:

1. Explains the overall concept and menu/navigation to warehouse operators for training.
2. Gives AI agents a searchable registry of features, their boundaries, and the files that implement them.

This design proposes a Markdown-only documentation system under `docs/app-docs/`.

---

## 2. Audience and Success Criteria

### 2.1 Human audience (operators / trainers)

- Can open `docs/app-docs/README.md` and follow the table of contents.
- Can read one file per flow (picking, receiving, put-away, measuring, goods-verify) and understand the concept, steps, and common issues.
- Can find shared UI components and what they do.

### 2.2 AI audience (coding agents)

- Can open `docs/app-docs/ai/feature-registry.md` and locate which files implement a given feature.
- Can read a per-feature `ai-scope.md` file and know what is inside scope, out of scope, and what known limitations exist.
- Can use frontmatter/metadata blocks to answer "does this feature exist?" and "where is it implemented?" questions without grepping the whole tree.

### 2.3 Success criteria

- A new developer can read `docs/app-docs/README.md` and understand the app in 10 minutes.
- A coding agent asked "how does OCR-assisted picking work?" can answer using only `docs/app-docs/` files.
- Every major flow has a user guide and an AI scope block.
- No documentation duplicates `README.md` or `AGENTS.md`; it links to them instead.

---

## 3. Proposed Approaches

### Approach A: Single canonical file per feature

All user-guide and AI-scope content lives in one file per feature (e.g., `docs/app-docs/picking.md`).

- **Pros:** One source of truth; easy to update when a feature changes.
- **Cons:** Mixed audiences can make files long; harder to produce a clean training-only view.

### Approach B: Split audience folders

`docs/app-docs/user/` for training manuals and `docs/app-docs/ai/` for agent lookup.

- **Pros:** Clean separation; trainers read one tree, agents read another.
- **Cons:** Risk of duplication or drift between the two descriptions of the same feature.

### Approach C: Feature-centric structure with audience sections (Recommended)

Each feature has its own folder with a main doc that contains a human **User Guide** section and an explicit **AI Scope / Remarks** block. A top-level index and concept pages tie everything together.

- **Pros:** Single source of truth per feature, yet both audiences get targeted content; scales naturally as new flows are added.
- **Cons:** Slightly more files than Approach A.

---

## 4. Recommended Structure and TOC

**Root:** `docs/app-docs/`  
**Entry point:** `docs/app-docs/README.md`

```text
docs/app-docs/
├── README.md                              # Home + TOC + how to use this docs
├── concepts/
│   ├── overview.md                        # What the app is, demo limitations
│   ├── roles.md                           # Operator role, login
│   ├── navigation.md                      # Home screen, menu, app header, language switcher
│   └── data-model.md                      # Core entities: orders, items, shelves, boxes
├── flows/
│   ├── index.md                           # Flow summary / quick-reference matrix
│   ├── picking/
│   │   ├── overview.md                    # Concept and happy path
│   │   ├── steps.md                       # Step-by-step operator guide
│   │   ├── label-scan.md                  # OCR / label scan / review modal
│   │   ├── issue-reporting.md             # Reporting shortages/damages
│   │   └── ai-scope.md                    # Boundaries, related code, known limits
│   ├── receiving/
│   │   ├── overview.md
│   │   ├── steps.md
│   │   ├── mismatch-handling.md
│   │   └── ai-scope.md
│   ├── put-away/
│   │   ├── overview.md
│   │   ├── steps.md
│   │   └── ai-scope.md
│   ├── measuring/
│   │   ├── overview.md
│   │   ├── steps.md
│   │   ├── box-measurements.md
│   │   └── ai-scope.md
│   └── goods-verify/
│       ├── overview.md
│       ├── steps.md
│       └── ai-scope.md
├── components/
│   ├── shared-components.md               # DetailRow, DetailHeader, ScanFab, StatusBadge, EmptyState, modals
│   └── flow-components.md                 # Components under components/<flow>/
├── composables/
│   ├── index.md                           # Composable quick-reference table
│   └── <key-composables>.md               # One-pagers for useLabelScan, useScanMatchers, etc.
└── ai/
    ├── feature-registry.md                # Machine-readable index: feature → files, scope, status
    ├── scope-remark-template.md           # How to write an AI scope block
    └── code-map.md                        # Page/component ↔ source-file mapping
```

---

## 5. Content Conventions

### 5.1 Per-flow `overview.md`

- One-paragraph concept.
- When the flow is used in the warehouse.
- Link to the related `steps.md` and `ai-scope.md`.

### 5.2 Per-flow `steps.md`

- Numbered operator steps.
- Screens/transitions described in plain language.
- Common errors and recovery actions.

### 5.3 Per-flow `ai-scope.md`

Required sections:

- **In scope** — what the feature does today.
- **Out of scope** — what it explicitly does not do.
- **Key files** — pages, components, composables, db helpers.
- **Known limitations** — demo-only behavior, hardcoded values, missing backend.
- **Related specs/plans** — links to `docs/superpowers/specs/` and `docs/superpowers/plans/`.

### 5.4 `ai/feature-registry.md`

A Markdown table with columns:

| Feature | Flow | Status | Key Files | Scope Doc |
|---------|------|--------|-----------|-----------|

This is the fast-lookup page for agents.

### 5.5 `README.md` integration

- Add a "Documentation" section to the root `README.md` that points to `docs/app-docs/README.md`.
- Do not duplicate the TOC; just link to it.

---

## 6. Out of Scope

- A generated static site (Docsify/VitePress). The system stays Markdown-only as requested.
- In-app help overlays. Future work could consume these Markdown files, but that is not part of this design.
- Rewriting existing `docs/superpowers/` specs/plans. The new system links to them.
- Video or image assets. Screenshots may be added later; the first version creates a placeholder folder and notes where images will go, but does not include actual screenshots.

---

## 7. Verification

- `pnpm nuxt prepare` runs cleanly (documentation-only change, but confirms no accidental file interference).
- Every link in `docs/app-docs/README.md` resolves to an existing file.
- Every major flow directory contains at least `overview.md`, `steps.md`, and `ai-scope.md`.
- `ai/feature-registry.md` lists every flow and key shared component/composable.

---

## 8. Self-Review Checklist

- [ ] No TBD/TODO placeholders remain.
- [ ] Structure matches the approved TOC.
- [ ] Links to `README.md`, `AGENTS.md`, and `docs/superpowers/` are accurate.
- [ ] Each `ai-scope.md` covers in-scope, out-of-scope, key files, limitations, and related specs.
