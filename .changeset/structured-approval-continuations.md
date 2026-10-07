---
'@inflowpayai/inflow': patch
---

Make AEP enrollment and grant approvals resumable through structured MCP tool inputs. Preserve payment Fetch limits and
output options, omit request bodies and headers from continuation responses, and require restoring those original
arguments before resuming sensitive requests.
