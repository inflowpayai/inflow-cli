---
'@inflowpayai/inflow': patch
---

Keep local-state vault handling independent from runtime InFlow API keys, report locked authentication status with a
stable `VAULT_LOCKED` error, and isolate integration tests from the user's vault.
