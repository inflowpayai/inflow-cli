# @inflowpayai/inflow

## 0.8.0

### Minor Changes

- [#26](https://github.com/inflowpayai/inflow-cli/pull/26)
  [`30f0b97`](https://github.com/inflowpayai/inflow-cli/commit/30f0b976849ee2d424324c572f881dd37ce126b4) Thanks
  [@nkavian](https://github.com/nkavian)! - Surface Tempo MPP challenges in the `inspect`, `mpp inspect`, and `mpp pay`
  flows. Tempo challenges are projected and selected by their on-the-wire `amount` and `currency` — the same compact
  projection used for the `inflow` method — and can be paid with `--payment-method tempo`. The CLI carries no Tempo
  asset registry and no x402 concepts in the MPP path; currency/rail filters read the decoded challenge request
  directly. Also covers Tempo deposit-address data.

## 0.7.0

### Minor Changes

- [#21](https://github.com/inflowpayai/inflow-cli/pull/21)
  [`0127f1c`](https://github.com/inflowpayai/inflow-cli/commit/0127f1c37f72c1daab791dbf849c66431978ecae) Thanks
  [@nkavian](https://github.com/nkavian)! - Add `--bootstrap` and named-skill support to `--skill`, and project the web
  agent docs from the binary.
  - `--bootstrap` prints the agent setup guide (install, authenticate, load a playbook) - the same text served at
    https://inflowcli.ai/skill.md.
  - `--skill [name]` accepts an optional skill name (`--skill agentic-payments`, `--skill=agentic-payments`), defaulting
    to `agentic-payments`; unknown names exit 1 and list the available skills. Every `skills/<name>/SKILL.md` is
    embedded at build time.
  - Both flags are listed in `--help` global options.
  - `scripts/publish-skills.mjs` (wired into `build`/`release`) publishes the inflowcli.ai docroot from the binary:
    `skill.md` from `--bootstrap`, `llms.txt`/`llms-full.txt` from `--llms`/`--llms-full`, playbooks from
    `skills/*/SKILL.md`, and stamps the minimum Node version into the install scripts.
  - The npm `homepage`, skill metadata, and command descriptions now reference https://inflowcli.ai; user-facing strings
    are ASCII-only.

## 0.6.6

### Patch Changes

- [#19](https://github.com/inflowpayai/inflow-cli/pull/19)
  [`815b6a6`](https://github.com/inflowpayai/inflow-cli/commit/815b6a6e98415f421f9746b73bdef3333ad0894c) Thanks
  [@mnebliienko](https://github.com/mnebliienko)! - Propagate the terminal result of `mpp`/`x402` `pay` and `status` in
  agent mode.

  These commands delegate to async-generator pipelines that surface terminal failures as the generator's return value
  (`return c.error(...)`), not as a yielded chunk. The command wrappers consumed the delegate with a bare `yield*`,
  which forwards yielded chunks but drops the return value, so the wrapper returned `undefined`. In buffered agent
  output (`--format json`) the framework then took the success path and emitted `{ ok: true, data: [] }` with exit code
  0, swallowing errors such as `NO_FILTERED_MATCH`. The wrappers now `return yield*` the delegate, so the error envelope
  is emitted with a non-zero exit code.

## 0.6.5

### Patch Changes

- [#16](https://github.com/inflowpayai/inflow-cli/pull/16)
  [`5efbbbd`](https://github.com/inflowpayai/inflow-cli/commit/5efbbbd55054bc40346c44a211521c3d72ce20c1) Thanks
  [@mnebliienko](https://github.com/mnebliienko)! - Document per-surface skill and MCP installation, testing, and update
  flows, and accept assignment-form global boolean flags such as `--verbose=true`.

- [#18](https://github.com/inflowpayai/inflow-cli/pull/18)
  [`4c8ae86`](https://github.com/inflowpayai/inflow-cli/commit/4c8ae86527b8979236863f9960b65f8ec7f103ed) Thanks
  [@nkavian](https://github.com/nkavian)! - Add a top-level `inflow inspect <url>` command — a protocol-agnostic,
  read-only probe that detects MPP and x402 from a single 402 response.
  - `inflow inspect <url>` makes one unauthenticated probe and decodes both the MPP `WWW-Authenticate: Payment`
    challenges and the x402 `PAYMENT-REQUIRED` accepts from the same response. It carries only the probe-shape flags
    (`--method`, `--data`, `--header`); for filtered probes or full per-protocol detail, use `inflow mpp inspect` /
    `inflow x402 inspect`.
  - Agent shape (`--format json`): `{ outcome, url, method, detected, mpp[], x402[], warnings? }`. The `mpp` and `x402`
    arrays are always present (empty when a protocol is absent); `detected` lists the protocols that carry at least one
    usable entry, so a caller can choose the pay rail (MPP wins when both are present). The x402 `amount` is the
    seller's raw atomic units and `asset` is the full on-chain contract address / mint rendered verbatim — not a token
    symbol.
  - When the seller advertises MPP but no `inflow`-method challenge, the `NO_INFLOW_MATCH` warning and the human view
    name the methods the seller did offer (for example `tempo`) and the warning carries a structured `methods` array.
  - A 402 carrying neither protocol header reports `detected: []` with a `NO_PAYMENT_CHALLENGE` warning rather than
    failing; a present-but-undecodable header surfaces as a per-protocol warning.

  core (`@inflowpayai/inflow-core`): adds the `runCombinedInspectPipeline` flow and the `parseMppHeaderFromProbe` /
  `parseX402HeaderFromProbe` helpers shared by the per-protocol and combined inspects.

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
