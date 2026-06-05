---
'@inflowpayai/inflow': patch
'@inflowpayai/inflow-core': patch
---

Add a top-level `inflow inspect <url>` command — a protocol-agnostic, read-only probe that detects MPP and x402 from a
single 402 response.

- `inflow inspect <url>` makes one unauthenticated probe and decodes both the MPP `WWW-Authenticate: Payment` challenges
  and the x402 `PAYMENT-REQUIRED` accepts from the same response. It carries only the probe-shape flags (`--method`,
  `--data`, `--header`); for filtered probes or full per-protocol detail, use `inflow mpp inspect` /
  `inflow x402 inspect`.
- Agent shape (`--format json`): `{ outcome, url, method, detected, mpp[], x402[], warnings? }`. The `mpp` and `x402`
  arrays are always present (empty when a protocol is absent); `detected` lists the protocols that carry at least one
  usable entry, so a caller can choose the pay rail (MPP wins when both are present). The x402 `amount` is the seller's
  raw atomic units and `asset` is the full on-chain contract address / mint rendered verbatim — not a token symbol.
- When the seller advertises MPP but no `inflow`-method challenge, the `NO_INFLOW_MATCH` warning and the human view name
  the methods the seller did offer (for example `tempo`) and the warning carries a structured `methods` array.
- A 402 carrying neither protocol header reports `detected: []` with a `NO_PAYMENT_CHALLENGE` warning rather than
  failing; a present-but-undecodable header surfaces as a per-protocol warning.

core (`@inflowpayai/inflow-core`): adds the `runCombinedInspectPipeline` flow and the `parseMppHeaderFromProbe` /
`parseX402HeaderFromProbe` helpers shared by the per-protocol and combined inspects.
