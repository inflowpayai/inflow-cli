# @inflowpayai/inflow-core

## 0.8.0

### Minor Changes

- [#196](https://github.com/inflowpayai/inflow-cli/pull/196)
  [`99b70b8`](https://github.com/inflowpayai/inflow-cli/commit/99b70b8f5326887f096acb6345f8c2cbf5e83dc5) Thanks
  [@nkavian](https://github.com/nkavian)! - Honor the MPP challenge's selected payment header for initial and resumed
  payments, preserving separate application authentication headers.

  Use the payment SDK's HTTP codecs and wire types instead of maintaining a separate direct x402 foundation dependency.

  Upgrade the MPP and x402 SDK packages to their latest minor releases.

### Patch Changes

- [#200](https://github.com/inflowpayai/inflow-cli/pull/200)
  [`45083f9`](https://github.com/inflowpayai/inflow-cli/commit/45083f9b5d22fe842b85bd9f736c464fb614ffdf) Thanks
  [@nkavian](https://github.com/nkavian)! - Cancel pending approvals when AEP authentication or payment approval waits
  time out. Limit approval waits to 15 minutes and report unsuccessful cancellation in both interactive and agent
  output.

- [#199](https://github.com/inflowpayai/inflow-cli/pull/199)
  [`fc5ad06`](https://github.com/inflowpayai/inflow-cli/commit/fc5ad061c8547018f4b282b71cd6962c25c3de23) Thanks
  [@nkavian](https://github.com/nkavian)! - Reject unsupported MPP credential headers before creating payments,
  authorizing subscriptions, or replaying stored credentials. Preserve supported alternatives and separate AEP
  authentication when using Payment-Authorization.

- [#197](https://github.com/inflowpayai/inflow-cli/pull/197)
  [`c40447d`](https://github.com/inflowpayai/inflow-cli/commit/c40447d98992ced1d4797d6c39e6f614c061e820) Thanks
  [@nkavian](https://github.com/nkavian)! - Report CARD payment summaries in decimal dollars with uppercase USD across
  terminal, JSON, and MCP output. Match CARD offers with either USD or usd currency filters. Preserve raw challenge and
  credential values for protocol operations.

- [#198](https://github.com/inflowpayai/inflow-cli/pull/198)
  [`e93c7c3`](https://github.com/inflowpayai/inflow-cli/commit/e93c7c3bdc0a8faab4e88c31b7ad79ffa4f47b65) Thanks
  [@nkavian](https://github.com/nkavian)! - Protect in-progress credential writes from concurrent startup recovery.
  Report missing AEP credentials separately from a locked vault.

- [#201](https://github.com/inflowpayai/inflow-cli/pull/201)
  [`d39f8eb`](https://github.com/inflowpayai/inflow-cli/commit/d39f8ebd01049e52b9d5afc84d96045d3870b36b) Thanks
  [@nkavian](https://github.com/nkavian)! - Identify InFlow as the buyer service in x402 builder attribution while
  preserving seller attribution.

## 0.7.1

### Patch Changes

- [#170](https://github.com/inflowpayai/inflow-cli/pull/170)
  [`f5690d8`](https://github.com/inflowpayai/inflow-cli/commit/f5690d80a49c2b36d0532299dbbae1ec81ce4c15) Thanks
  [@nkavian](https://github.com/nkavian)! - Upgrade the AEP Agent SDK to 0.6.0 for protected-resource credential
  selection, redirect isolation, and pending-approval handling fixes.

## 0.7.0

### Minor Changes

- [#114](https://github.com/inflowpayai/inflow-cli/pull/114)
  [`98c94aa`](https://github.com/inflowpayai/inflow-cli/commit/98c94aa2731c53629d7422b2a7343bf7d051abe1) Thanks
  [@nkavian](https://github.com/nkavian)! - Add MPP subscription activation and protocol-neutral subscription management
  commands. Display recurring terms before approval, select among multiple subscription options with stable option
  identifiers, and provide list, get, fetch, and cancel commands. Each fetch obtains a fresh short-lived authorization
  from InFlow; no standing subscription credential is stored in the local vault. Subscription output includes active,
  past-due, expired, cancelled, revoked, pending, and failed lifecycle states plus the next scheduled billing attempt.
  Subscription output identifies the seller by name and presents the seller website as a hostname in human-readable CLI
  tables while retaining the complete website URL in structured output.

## 0.6.3

### Patch Changes

- [#94](https://github.com/inflowpayai/inflow-cli/pull/94)
  [`a676003`](https://github.com/inflowpayai/inflow-cli/commit/a676003d8c42306b6e545f187bad480fcc83e80a) Thanks
  [@nkavian](https://github.com/nkavian)! - Protect vault initialization and credential rotation from partial
  vault-header writes.

- [#96](https://github.com/inflowpayai/inflow-cli/pull/96)
  [`efb0a12`](https://github.com/inflowpayai/inflow-cli/commit/efb0a12a1276aaea6ddfdb8868597732fb6885b8) Thanks
  [@nkavian](https://github.com/nkavian)! - Preserve recoverable credential lifecycle state when secure storage deletion
  is temporarily unavailable.

## 0.6.2

### Patch Changes

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
