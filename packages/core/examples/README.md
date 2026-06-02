# Examples

Runnable scripts that exercise `@inflowpayai/inflow-core` end-to-end without touching the CLI binary. Useful as a sanity
check that the package is genuinely self-sufficient as a Node-only SDK, and as a copy target when someone wants to embed
InFlow into their own service.

## `programmatic-login-and-balances.ts`

Drives `inflow.auth.login` interactively (device flow), then calls `inflow.balances.list` once tokens land. Uses
`MemoryStorage` so the credentials live for the lifetime of the script. For a long-running tool, swap in the file-backed
`Storage` and the session persists.

Run:

```bash
node --experimental-strip-types packages/core/examples/programmatic-login-and-balances.ts
```

## `programmatic-x402-pay.ts`

Drives the full x402 payment lifecycle (probe → decode → match → sign → replay) against a real seller URL. Uses a static
`apiKey` for authentication so there's no device flow to walk through. Prints each phase transition to stdout and exits
non-zero on any terminal failure state (`replay-rejected`, `errored`, …).

Run:

```bash
INFLOW_API_KEY=inflow_... X402_SELLER_URL=https://seller.test/api \
  node --experimental-strip-types packages/core/examples/programmatic-x402-pay.ts
```

Optional environment overrides: `INFLOW_ENVIRONMENT` (`sandbox` | `production`, default `sandbox`), `INFLOW_BASE_URL`
(override the SDK's environment-derived URL).

## `programmatic-mpp-pay.ts`

Drives the full MPP payment lifecycle (probe → parse `WWW-Authenticate: Payment` challenge(s) → create → poll to `ready`
→ replay with the `Authorization: Payment` credential) against a real seller URL. The MPP analog of
`programmatic-x402-pay.ts`: uses a static `apiKey` (no device flow), subscribes to `inflow.mpp.pay`'s async-iterable
event stream, prints each phase transition, and exits non-zero on any terminal failure (`seller-rejected`, `errored`).

Run:

```bash
INFLOW_API_KEY=inflow_... MPP_SELLER_URL=https://seller.test/api \
  node --experimental-strip-types packages/core/examples/programmatic-mpp-pay.ts
```

Optional environment overrides: `INFLOW_ENVIRONMENT` (`sandbox` | `production`, default `sandbox`), `INFLOW_BASE_URL`
(override the SDK's environment-derived URL).

## Why these aren't tests

The unit suites in `packages/core/test/unit/` mock the network. The examples here hit real endpoints (`inflowpay.ai` and
a seller URL). They are documentation that compiles, not gates that CI runs.
