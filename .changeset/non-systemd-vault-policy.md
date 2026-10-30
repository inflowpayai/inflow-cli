---
'@inflowpayai/inflow': patch
---

Default vault sleep locking to off on Linux without systemd. Keep the eight-hour idle timeout and preserve saved
policies. Sleep locking remains enabled by default on systemd Linux, macOS, and Windows.
