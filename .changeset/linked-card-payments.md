---
'@inflowpayai/inflow': minor
---

Support linked-card selection for MPP and x402 payments. Prefer balance and exact offers before x402 Instrument offers,
and constrain explicit instrument selection without falling back to another funding method.

Guide buyers through bank verification and resume the original MPP or x402 Instrument purchase after settlement.
Stopping a verification wait does not cancel the submitted payment. Structured output includes the verification URL and
original-transaction continuation details without exposing payment credentials or request headers.

Return bank-verification continuations only when polling has stopped, preserving polling limits and output options.
