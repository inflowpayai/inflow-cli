---
'@inflowpayai/inflow': minor
'@inflowpayai/inflow-core': minor
---

Add MPP subscription activation and protocol-neutral subscription management commands. Display recurring terms before
approval, select among multiple subscription options with stable option identifiers, and provide list, get, fetch, and
cancel commands. Each fetch obtains a fresh short-lived authorization from InFlow; no standing subscription credential
is stored in the local vault. Subscription output includes active, past-due, expired, cancelled, revoked, pending, and
failed lifecycle states plus the next scheduled billing attempt. Subscription output identifies the seller by name and
presents the seller website as a hostname in human-readable CLI tables while retaining the complete website URL in
structured output.
