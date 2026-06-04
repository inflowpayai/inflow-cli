---
"@inflowpayai/inflow": patch
---

Unify plugin install naming and keep `pnpm verify` idempotent.

- Rename the Cursor and agents marketplaces to `inflow` (matching the Claude marketplace, the plugin, and the `inflow` binary), so the install target is `inflow@inflow` on every host.
- Correct the README install command to `/plugin install inflow@inflow`, and note that `inflowpayai/inflow-cli` is only the GitHub repo slug.
- Stamp the version in the manifest JSON files surgically (replace only the `version` value) instead of reserializing with `JSON.stringify`, which reflowed arrays one-element-per-line and fought Prettier. `build` no longer leaves manifests in a shape the next `format` rewrites, so the pipeline converges in one pass.
