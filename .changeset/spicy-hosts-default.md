---
'@inflowpayai/inflow': patch
---

Default the production API base URL to `https://api.inflowpay.ai` for data endpoints, while OAuth/device auth keeps
using `https://app.inflowpay.ai`. A single `INFLOW_BASE_URL` (or `apiBaseUrl`) override still redirects both hosts, so
pointing the CLI at another environment stays a one-variable change.
