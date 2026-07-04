# Flow-Specific Components

Components organized under `components/<flow>/` are used primarily by that flow.

## Picking components

`components/picking/`

See the folder contents for picking-specific UI pieces.

## Receiving components

`components/receiving/`

See the folder contents for receiving-specific UI pieces.

## Put-away components

`components/put-away/`

See the folder contents for put-away-specific UI pieces.

## Notes for agents

When adding a new flow-specific component, create a folder under `components/<flow>/` and keep it focused on that flow. Shared behavior should be extracted to `composables/` or shared components at the top level.
