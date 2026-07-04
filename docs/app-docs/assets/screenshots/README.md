# Screenshots

UI screenshots are stored in `assets/` folders next to the documentation content that uses them.

## Location convention

Place screenshots in the same folder as the markdown file that references them:

- `docs/app-docs/user-menu/assets/` — login and home screens
- `docs/app-docs/flows/<flow>/assets/` — list and detail screens for each flow
- `docs/app-docs/concepts/assets/` — conceptual/navigation screenshots
- `docs/app-docs/components/assets/` — component screenshots

## Naming convention

Use the format:

```
<flow>-<screen>-<description>.png
```

Examples:

- `picking-list-default.png`
- `receiving-detail-invoice.png`
- `measuring-box-measurements-modal.png`

## Guidelines

- Use the same language/state as the demo seed data.
- Capture only the relevant screen area.
- Keep file sizes reasonable (compress PNGs).
- Reference images with a relative link from the markdown file, e.g. `![caption](./assets/<flow>-<screen>.png)`.

## Current status

Screenshots have been added for the user menu, navigation, and all warehouse flows.
