---
'@inflowpayai/inflow': patch
---

Reduce redundant vault preparation and credential reads while preserving connection verification and lock enforcement.
Reject token refresh results for sessions that were logged out or replaced.
