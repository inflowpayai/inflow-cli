---
'@inflowpayai/inflow': minor
---

Add ODP Service directory search, inspection, Collection navigation, per-Service and federated Offering discovery, and
read-only Action resolution. Protected catalog reads use the existing AEP runtime, and catalog caches are isolated by a
verified access context or disabled. Resolved Action targets compose with the existing MPP and x402 payment commands.
ODP failures return stable error codes without exposing internal errors or stack traces. Direct Service commands reject
unadvertised operations with an actionable alternative, and the agentic discovery playbook guides capability-aware
catalog navigation. Offering search exposes resolved filters and sorts, and aggregate discovery derives its required
Service operation from the Offering request. The top-level inspect command reports ODP Service metadata before
enrollment and payment details. Interactive ODP commands render tabular directory, Collection, Offering, capability, and
Action results with copyable continuation commands and absolute schema-declared URLs. AEP Service identity mismatches
fail with a stable non-retryable error. Offering lists include descriptions, Collection hierarchy labels use explicit
terminology, and directory search presents facet counts as available filters over the complete matching result set.
Offering details present structured Price Preview semantics and explicit Action and Offering identifiers. Invalid AEP
Grant responses return a stable error instead of an internal-error fallback. Resource details omit Service-level ODP
versions and empty localization metadata. Collection and Offering searches reject missing search criteria locally with
actionable list-command guidance. Resolved compact Actions display their schema-declared inputs, required fields, and
selectable values. MPP and x402 requests with `--data` retain the documented JSON content type through AEP-aware probes
and payment replays.
