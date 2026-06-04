# @inflowpayai/inflow

## 0.6.4

### Patch Changes

- [#14](https://github.com/inflowpayai/inflow-cli/pull/14)
  [`278209e`](https://github.com/inflowpayai/inflow-cli/commit/278209ec13f733c0eff88a7b39823a6da2468b85) Thanks
  [@nkavian](https://github.com/nkavian)! - Clear the pending device-auth record after a successful inline `auth login`.

  The inline (agent / `--interval`) device-login path persisted the new tokens but left `pendingDeviceAuth` in the
  config file. Because `composeAuthSnapshot` prefers a pending record over saved tokens, `auth status` would report
  `authenticated: false, pending: true` despite a successful login until the device code expired. `runAuthLogin` now
  calls `clearPendingDeviceAuth()` in the same success step that writes the tokens, so the record is dropped
  immediately.

## 0.6.3

### Patch Changes

- [#12](https://github.com/inflowpayai/inflow-cli/pull/12)
  [`8036cd1`](https://github.com/inflowpayai/inflow-cli/commit/8036cd1e37531cce85b2e21df4ab930827cc0cf0) Thanks
  [@nkavian](https://github.com/nkavian)! - Unify plugin install naming and keep `pnpm verify` idempotent.
  - Rename the Cursor and agents marketplaces to `inflow` (matching the Claude marketplace, the plugin, and the `inflow`
    binary), so the install target is `inflow@inflow` on every host.
  - Correct the README install command to `/plugin install inflow@inflow`, and note that `inflowpayai/inflow-cli` is
    only the GitHub repo slug.
  - Stamp the version in the manifest JSON files surgically (replace only the `version` value) instead of reserializing
    with `JSON.stringify`, which reflowed arrays one-element-per-line and fought Prettier. `build` no longer leaves
    manifests in a shape the next `format` rewrites, so the pipeline converges in one pass.

## 0.6.2

### Patch Changes

- [#10](https://github.com/inflowpayai/inflow-cli/pull/10)
  [`fa8d827`](https://github.com/inflowpayai/inflow-cli/commit/fa8d827e82dc556dddb2d39b7c450bcc715c1fb5) Thanks
  [@nkavian](https://github.com/nkavian)! - Fix the plugin bundle so the skill and MCP server actually load, and broaden
  host coverage.
  - Add `skills`, `.mcp.json`, and `assets` symlinks under `plugins/inflow/` so the per-plugin manifests' `./skills/`,
    `./.mcp.json`, and `./assets/` paths resolve (previously they pointed at nonexistent paths and the skill/MCP server
    never loaded).
  - Add a Cursor per-plugin manifest (`plugins/inflow/.cursor-plugin/plugin.json`), a Cursor marketplace entry
    (`.cursor-plugin/marketplace.json`), and an agents marketplace entry (`.agents/plugins/marketplace.json`).
  - Stamp the repo-root `package.json` and the new Cursor per-plugin manifest from the version-sync script.
  - Mention MPP alongside x402 in the Codex top-level manifest and Claude marketplace descriptions.
  - Document agent/plugin install paths in the README.

## 0.6.1

### Patch Changes

- [#8](https://github.com/inflowpayai/inflow-cli/pull/8)
  [`61c8a3b`](https://github.com/inflowpayai/inflow-cli/commit/61c8a3b956116cf09aae4f473cc1bad04ec6c074) Thanks
  [@nkavian](https://github.com/nkavian)! - Drop the removed `settlement` field from MPP receipt handling.
  `@inflowpayai/mpp`'s `MppReceipt` no longer carries `settlement` (amount/currency), so `mpp pay` no longer projects
  `amount`/`currency` into its settlement summary, the `mpp decode` receipt view no longer prints a settled amount, and
  the receipt discriminator now keys on `challengeId`.

## 0.6.0

### Minor Changes

- [#5](https://github.com/inflowpayai/inflow-cli/pull/5)
  [`2d56708`](https://github.com/inflowpayai/inflow-cli/commit/2d5670854392e0e7c6218ad327c6f9435ce971e1) Thanks
  [@nkavian](https://github.com/nkavian)! - Add Machine Payments Protocol (MPP) support.

  The CLI gains a new `mpp` command group — `pay`, `status`, `inspect`, `decode`, `cancel`, and `supported` — backed by
  new core flows (`mpp-pay`, `mpp-status`, `mpp-inspect`, `mpp-decode`, `mpp-cancel`, `mpp-supported`, and shared
  helpers). A `use-flow-exit` hook and `best-effort-cancel` util provide graceful cancellation on interrupt, and a
  programmatic MPP pay example is added to `@inflowpayai/inflow-core`. Also refreshes x402 flow internals, docs, plugin
  manifests, and the agentic-payments skill.

## 0.5.2

### Patch Changes

- [#2](https://github.com/inflowpayai/inflow-cli/pull/2)
  [`c1879a0`](https://github.com/inflowpayai/inflow-cli/commit/c1879a0a2a907ae469a779a5049996607cf0fef0) Thanks
  [@nkavian](https://github.com/nkavian)! - Fix CI test races and pnpm-only settings leaking into npm.
