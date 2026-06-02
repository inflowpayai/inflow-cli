---
'@inflowpayai/inflow': patch
'@inflowpayai/inflow-core': patch
---

Drop the removed `settlement` field from MPP receipt handling. `@inflowpayai/mpp`'s `MppReceipt` no longer carries
`settlement` (amount/currency), so `mpp pay` no longer projects `amount`/`currency` into its settlement summary, the
`mpp decode` receipt view no longer prints a settled amount, and the receipt discriminator now keys on `challengeId`.
