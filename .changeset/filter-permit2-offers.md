---
'@inflowpayai/inflow': patch
---

Exclude Permit2 and upto offers from detected x402 payment options and payment selection because InFlow treasury
payments cannot authorize them. Preserve exact EIP-3009, Solana, and balance offers.
