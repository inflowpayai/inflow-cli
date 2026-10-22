---
'@inflowpayai/inflow': patch
---

Prevent repeated subscription cancellation requests during interactive rendering.

Preserve approval denial, timeout, cancellation, and server-error responses when AEP fetch or payment authentication
requires signing approval.

Expand regression coverage for authentication, credential storage, discovery, and payment command flows.

Forward explicitly configured bearer access tokens to the MPP and x402 payment clients.

Release public-document stream readers even when cancellation fails after a stream error.

Keep platform request timeouts and cancellation active while reading response bodies.

Preserve existing platform identity lookup during AEP fetch and payment authentication without automatically
provisioning or enrolling an identity.

Clear the current passphrase buffer when the replacement-passphrase prompt is cancelled.
