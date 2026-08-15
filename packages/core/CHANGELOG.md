# @inflowpayai/inflow-core

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
