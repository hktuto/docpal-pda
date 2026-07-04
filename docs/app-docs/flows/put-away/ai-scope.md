# Put-away — AI Scope and Remarks

## In scope

- List put-away tasks.
- Show detail with receiving-area items.
- Select a destination shelf.
- Move items into shelf boxes.
- Update inventory lot locations.

## Out of scope

- Automated put-away suggestions based on velocity or zone.
- Forklift or robot integration.
- Multi-step directed put-away with confirmation checkpoints.

## Key files

- `pages/put-away/` — list and detail pages.
- `components/put-away/` — put-away-specific components.
- `components/SelectShelfDialog.vue` — shelf selection UI.
- `db/putAway.ts` — put-away DB helpers.

## Known limitations

- Shelf selection is manual.
- No validation of shelf capacity or restrictions.

## Related specs/plans

- `docs/superpowers/specs/2026-07-03-cancel-empty-box-design.md`
