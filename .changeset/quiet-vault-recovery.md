---
'@inflowpayai/inflow-core': patch
'@inflowpayai/inflow': patch
---

Protect in-progress credential writes from concurrent startup recovery. Report missing AEP credentials separately from a
locked vault.
