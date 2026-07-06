# Put-away — AI Scope and Remarks

## In scope

- List put-away tasks.
- Show detail with receiving-area items.
- Scan physical pieces into a receiving item, then move whole scanned pieces into shelf boxes.
- Select a destination shelf.
- Update inventory lot locations.

## Out of scope

- Automated put-away suggestions based on velocity or zone.
- Forklift or robot integration.
- Multi-step directed put-away with confirmation checkpoints.

## Key files

- `pages/put-away/index.vue` — list page.
- `pages/put-away/[id].vue` — detail page.
- `components/put-away/PutAwayLotsPanel.vue` — receiving items and scan management.
- `components/put-away/ShelfBoxesPanel.vue` — open shelf boxes and piece assignment.
- `components/SelectShelfDialog.vue` — shelf selection UI.
- `db/putAway.ts` — put-away DB helpers.

## Known limitations

- Shelf selection is manual.
- No validation of shelf capacity or restrictions.
- Scanned pieces are tracked per receiving invoice item. The app does not support splitting a single scanned piece across multiple boxes.

## Related specs/plans

- `docs/superpowers/specs/2026-07-03-cancel-empty-box-design.md`
- `docs/superpowers/specs/2026-07-06-put-away-scan-first-design.md`
- `docs/superpowers/plans/2026-07-06-put-away-scan-first.md`
