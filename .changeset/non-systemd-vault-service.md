---
'@inflowpayai/inflow': minor
---

Add explicit administrator startup for the packaged Linux vault on systems without systemd. Keep vault unlocking under
the ordinary user's identity, enforce the service sandbox, and report startup instructions when the service is absent.
Fix a Linux broker handoff race that could lose the first request after authentication during concurrent startup. Close
active and authenticating vault connections during service shutdown so connected clients do not block package upgrades
or service recovery.
