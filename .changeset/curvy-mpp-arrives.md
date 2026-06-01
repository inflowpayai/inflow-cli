---
'@inflowpayai/inflow': minor
'@inflowpayai/inflow-core': minor
---

Add Machine Payments Protocol (MPP) support.

The CLI gains a new `mpp` command group — `pay`, `status`, `inspect`, `decode`, `cancel`, and `supported` — backed by
new core flows (`mpp-pay`, `mpp-status`, `mpp-inspect`, `mpp-decode`, `mpp-cancel`, `mpp-supported`, and shared
helpers). A `use-flow-exit` hook and `best-effort-cancel` util provide graceful cancellation on interrupt, and a
programmatic MPP pay example is added to `@inflowpayai/inflow-core`. Also refreshes x402 flow internals, docs, plugin
manifests, and the agentic-payments skill.
