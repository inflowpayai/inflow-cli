---
'@inflowpayai/inflow': patch
---

Correct command input schemas so options with defaults are optional in `--schema`, generated command documentation, and
MCP discovery. Preserve output-schema requirements and argument parsing.

Describe AEP, ODP, directory, OpenAPI, combined inspection, vault, logout, and subscription management responses in
command schemas and MCP discovery, with structured MCP results matching the existing text responses. Include existing
AEP timeout and polling limits in input metadata. Payment and streaming or array response schemas remain outside this
change.
