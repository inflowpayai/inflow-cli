---
'@inflowpayai/inflow-core': patch
'@inflowpayai/inflow': patch
---

Reject unsupported MPP credential headers before creating payments, authorizing subscriptions, or replaying stored
credentials. Preserve supported alternatives and separate AEP authentication when using Payment-Authorization.
