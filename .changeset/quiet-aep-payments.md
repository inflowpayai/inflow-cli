---
'@inflowpayai/inflow': minor
---

Make MPP and x402 pay/fetch AEP-aware. Seller requests complete AEP authentication before payment creation, compose
non-colliding AEP and payment credentials on the final replay, and preserve the payment fetch continuation contract. AEP
fetch reports payment-required handoffs, and combined inspect reports blocked AEP payment inspection without creating
grants, approvals, or payments.
