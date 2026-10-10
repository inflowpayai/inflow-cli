---
'@inflowpayai/inflow': patch
---

Reduce repeated vault authentication overhead by reusing connections within CLI commands and MCP sessions, while
preserving existing security checks and improving vault lifecycle reliability on macOS, Linux, and Windows. Keep signed
macOS packaging from invalidating the development CLI's native module.
