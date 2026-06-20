---
'@inflowpayai/inflow': minor
---

Surface Tempo MPP challenges in the `inspect`, `mpp inspect`, and `mpp pay` flows. Tempo challenges are projected and
selected by their on-the-wire `amount` and `currency` — the same compact projection used for the `inflow` method — and
can be paid with `--payment-method tempo`. The CLI carries no Tempo asset registry and no x402 concepts in the MPP path;
currency/rail filters read the decoded challenge request directly. Also covers Tempo deposit-address data.
