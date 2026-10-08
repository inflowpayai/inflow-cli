---
'@inflowpayai/inflow': patch
---

Advertise application/odp+json when inspecting public service documents so ODP services with strict content negotiation
do not reject discovery with HTTP 406. Validate ODP response media types without restricting OpenAPI documents or their
JSON references.
