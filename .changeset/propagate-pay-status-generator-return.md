---
'@inflowpayai/inflow': patch
---

Propagate the terminal result of `mpp`/`x402` `pay` and `status` in agent mode.

These commands delegate to async-generator pipelines that surface terminal failures as the generator's return value
(`return c.error(...)`), not as a yielded chunk. The command wrappers consumed the delegate with a bare `yield*`, which
forwards yielded chunks but drops the return value, so the wrapper returned `undefined`. In buffered agent output
(`--format json`) the framework then took the success path and emitted `{ ok: true, data: [] }` with exit code 0,
swallowing errors such as `NO_FILTERED_MATCH`. The wrappers now `return yield*` the delegate, so the error envelope is
emitted with a non-zero exit code.
