---
'@inflowpayai/inflow': minor
---

Add Agent Enrollment Protocol Service inspection, enrollment with Platform identity recovery and duplicate prevention,
status, credential issuance, and revocation commands. Detect AEP authentication in the top-level inspect command and
present AEP inspection and status details in tables. Store authentication secrets and AEP credential payloads in the
encrypted local vault, with non-secret metadata in SQLite. On first use, delete the legacy plaintext `config.json`
without migrating its credentials, requiring users to authenticate and enroll again. Add resource-aware AEP inspection
and `aep fetch`, including anonymous success, caller request preservation, identity recovery, stored credential
selection, pending Sign approval continuation, bounded redirects and responses, and structured resource body output.
Persist fresh AEP Inspect documents per authenticated Platform user so separate CLI invocations reuse discovery safely.
Ship a dedicated `agentic-enrollment` skill through the CLI, plugin, and web publication surfaces, and include every AEP
command in language-model and MCP inventory regression coverage.
