---
'@inflowpayai/inflow': patch
'@inflowpayai/inflow-core': patch
---

Cancel pending approvals when AEP authentication or payment approval waits time out. Limit approval waits to 15 minutes
and report unsuccessful cancellation in both interactive and agent output.
