---
'@inflowpayai/inflow': patch
---

Clear the pending device-auth record after a successful inline `auth login`.

The inline (agent / `--interval`) device-login path persisted the new tokens but left `pendingDeviceAuth` in the config
file. Because `composeAuthSnapshot` prefers a pending record over saved tokens, `auth status` would report
`authenticated: false, pending: true` despite a successful login until the device code expired. `runAuthLogin` now calls
`clearPendingDeviceAuth()` in the same success step that writes the tokens, so the record is dropped immediately.
