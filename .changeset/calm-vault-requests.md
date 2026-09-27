---
'@inflowpayai/inflow': patch
---

Prepare the credential vault consistently for AEP inspection, account queries, payments, and MCP tools. Report locked
credentials before protocol requests, retain anonymous inspection on fresh installations, and enable the AEP-aware ODP
transport for MCP.

When a saved API key cannot be loaded because the vault is locked or stopped at MCP startup, require unlocking and
reconnecting MCP before credential-using operations. Public operations remain available.
