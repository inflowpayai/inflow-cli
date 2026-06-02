# @inflowpayai/inflow-core

Headless InFlow client. Same surface the CLI uses, with no Ink, no React, no command framework — Node only.

Workspace-internal: not currently published to npm. Imported by `@inflowpayai/inflow` (the CLI) via the pnpm workspace.

## What's in here

The package exposes three things:

1. **Augmented resource handles** — one per command group, hung off the `Inflow` instance. Each handle carries both the
   typed HTTP primitives and the command-shaped operations the CLI runs:
   - `inflow.auth` (`IAuth`) — protocol primitives (`initiateDeviceAuth` / `pollDeviceAuth` / `refreshToken` /
     `revokeToken`) plus `login` / `loginApiKey` / `logout` / `snapshot` / `probeStatus` / `pollStatus`.
   - `inflow.user` (`IUser`) — `retrieve()` (raw payload) plus `get()` (agent-mode projection that drops `created` /
     `updated`).
   - `inflow.balances` (`IBalanceResource`) — `list()`.
   - `inflow.depositAddresses` (`IDepositAddressResource`) — `list()`.
   - `inflow.x402` (`IX402`) — `client()` (lazy buyer client) plus `pay` / `status` / `cancel` / `inspect` /
     `supported`.
   - `inflow.mpp` (`IMpp`) — `client()` (lazy `MppClient` for MPP, the Machine Payments Protocol, from
     `@inflowpayai/mpp`) plus `pay` / `status` / `cancel` / `inspect` / `supported`; the pure-codec `decodeMppValue`
     decodes a `WWW-Authenticate: Payment` header or a base64url credential / receipt.

   Every handle is sanitized through an ANSI-stripping Proxy so server-controlled strings can never carry terminal
   escape codes into the consumer. Stateful operations (`pay`, `inspect`, `auth.login`) return a `FlowRun<E>` whose
   `events` is an async- iterable — drive them with your own reducer or just consume the terminal event. Auth-side
   methods that need storage throw `InflowConfigurationError` at call time when no `authStorage` was configured.

2. **Top-level Inflow members** — `inflow.hasApiKey()` predicate and the `inflow.resolvedApiBaseUrl: string` getter (the
   canonical URL the resources will actually hit after resolving `apiBaseUrl`, `INFLOW_BASE_URL`, and the
   environment-derived default).

3. **Helpers** — `sanitizeDeep`, `sanitizeResource`, the `Storage` / `MemoryStorage` classes, the `pollAsync` generic,
   the seller-probe primitives (`sellerProbe`, `replayWithPayment`, `describeBody`), the x402 decode helpers
   (`decodeHeader`, `summarizeAccepts`), plus the `approvalUrlFor` / `dashboardHostFor` URL helpers. All used inside the
   augmented handles; all re-exported for direct consumption.

## Two-minute tour

```ts
import { Inflow, MemoryStorage } from '@inflowpayai/inflow-core';

const inflow = new Inflow({
  apiKey: process.env.INFLOW_API_KEY,
  environment: 'sandbox',
});

const balances = await inflow.balances.list();
const user = await inflow.user.retrieve();
const userAgent = await inflow.user.get();

const storage = new MemoryStorage();
const sessionInflow = new Inflow({ authStorage: storage, environment: 'sandbox' });
const login = sessionInflow.auth.login({
  clientName: 'My Tool',
  connection: { environment: 'sandbox' },
});
for await (const event of login.events) {
  if (event.type === 'initiated') console.log('Open', event.req.verification_url);
  if (event.type === 'tokensReceived') console.log('Logged in');
}

console.log('Hitting', inflow.resolvedApiBaseUrl);
```

For a deeper walk-through see `examples/` (programmatic login + balances; programmatic x402 pay).

## Credential resolution

`new Inflow({ ... })` accepts one of:

- `apiKey` — static API key. Every authenticated call sends it as `X-API-KEY`.
- `accessToken` — static OAuth bearer. Sent as `Authorization: Bearer`.
- `getAccessToken` — callback that returns a fresh token per call. Used for OAuth deployments where the caller manages
  the refresh cycle out-of-band.
- `authStorage` (alone) — when no static credential is set but `authStorage` is, the data resources get a device-token
  provider auto-wired from the auth resource + storage. Run `inflow.auth.login` once, tokens land in storage, subsequent
  reads transparently refresh. This is the CLI's mode.
- None of the above — anonymous. The data resources construct but fail at request time. Useful when only `inflow.auth.*`
  is needed.

## Network

Set `INFLOW_HTTP_PROXY` to route every outbound HTTP request through a proxy. The SDK lazy-loads `undici`'s `ProxyAgent`
on first use; install it as a peer (`npm install undici`) when the env var is set. The proxy is ignored when the caller
passes a custom `fetch` — bring your own dispatcher in that case.

## Boundary

This package is the headless contract. It must not import any CLI-rendering library (`react`, `ink`, `incur`,
`update-notifier`, etc.). The repo's ESLint config has a `no-restricted-imports` rule scoped to `packages/core/src/**`
that fails the lint step on any such import. Add new bans there when promoting more CLI-only deps.

The CLI binary (`@inflowpayai/inflow`) is the only sanctioned consumer today; the package is workspace-internal
(`private: true` in `package.json`).
