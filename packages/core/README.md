# @inflowpayai/inflow-core

Headless InFlow client. Same surface the CLI uses, with no Ink, no React, no command framework — Node only.

Workspace-internal: not currently published to npm. Imported by `@inflowpayai/inflow` (the CLI) via the pnpm workspace.

Use this package when developing the InFlow CLI itself or embedding its headless flows inside this workspace. External
applications should use the signed `inflow` binary or its MCP server; this package has no independent npm compatibility
promise while it remains private.

## TAP request authentication

The TAP transport sends unsigned requests when no InFlow login is stored or an API key is selected. With a device-token
login, it uses InFlow's signing endpoint and refreshes expired access tokens through the normal authentication flow.
Locked credentials and signing failures stop the request; they do not trigger an unsigned retry. OpenAPI document
discovery and operation calls use the public HTTP transport without TAP.

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
   - `inflow.subscriptions` (`ISubscriptionResource`) — `authorize()`, `list()`, `get()`, and `cancel()`.
   - `inflow.x402` (`IX402`) — `client()` (lazy buyer client) plus `pay` / `status` / `cancel` / `inspect` /
     `supported`.
   - `inflow.mpp` (`IMpp`) — `client()` (lazy `MppClient` for MPP, the Machine Payments Protocol, from
     `@inflowpayai/mpp`) plus `pay` / `status` / `cancel` / `inspect` / `supported`; the pure-codec `decodeMppValue`
     decodes a `WWW-Authenticate: Payment` header or a base64url credential / receipt.
   - `inflow.odp` (`IOdpResource`) — mixed Service/Collection `search`, `continueSearch`, and name `suggest` operations;
     Service-only `searchServices`, `continueSearchServices`, and `suggestServices`; Service inspection and catalog
     clients, plus bounded multi-Service Offering discovery. The InFlow environment selects ODP production or sandbox;
     the directory endpoint cannot be overridden.

   Every handle is sanitized through an ANSI-stripping Proxy so server-controlled strings can never carry terminal
   escape codes into the consumer. Stateful operations (`pay`, `inspect`, `auth.login`) return a `FlowRun<E>` whose
   `events` is an async- iterable — drive them with your own reducer or just consume the terminal event. Auth-side
   methods that need storage throw `InflowConfigurationError` at call time when no `authStorage` was configured.

2. **Top-level Inflow members** — `inflow.hasApiKey()` predicate and the `inflow.resolvedApiBaseUrl: string` getter (the
   canonical URL the resources will actually hit after resolving `apiBaseUrl`, `INFLOW_BASE_URL`, and the
   environment-derived default).

3. **Helpers** — `sanitizeDeep`, `sanitizeResource`, the `Storage` / `MemoryStorage` classes, the `pollAsync` generic,
   the seller-request primitives (`sellerProbe`, `sellerRequest`, `replayWithPayment`, `replayPaymentRequest`,
   `describeBody`), the x402 decode helpers (`decodeHeader`, `summarizeAccepts`), plus the `approvalUrlFor` /
   `dashboardHostFor` URL helpers. All used inside the augmented handles; all re-exported for direct consumption.

## Public source discovery

`SourceDiscovery` reads public ODP and JSON OpenAPI documents without constructing an authenticated InFlow client or
opening the vault. It does not invoke operations, enroll, obtain credentials, or make payments.

```ts
import { SourceDiscovery } from '@inflowpayai/inflow-core';

const discovery = new SourceDiscovery();
const source = await discovery.inspect('https://service.example', { format: 'openapi' });
const exact = await discovery.inspect('https://service.example/contracts/search.json', { refresh: true });
```

Origin inspection prefers ODP unless `format: 'openapi'` is explicit. OpenAPI discovery checks the ODP-advertised
OpenAPI URL, `/openapi.json`, `/v1/openapi.json`, and the OpenAPI link in `/.well-known/x402.json`. Multiple valid
documents produce `SOURCE_AMBIGUOUS` with candidate URLs; supply one exact URL. Exact URLs retain their path and query
and never fall back to another document. HTTP failures are not treated as absence.

The default public SQLite cache uses separate document and discovered-location namespaces. Neither reads credential
records nor performs secret-lifecycle recovery. Freshness defaults to ten minutes; HTTP freshness directives and
conditional revalidation take precedence. `refresh: true` bypasses freshness. `no-store` prevents both document and
derived-location persistence. Each namespace is bounded to 128 records and 32 MiB; one response is limited to 4 MiB.
Stale fetch failures are errors, not permission to use stale content.

`OpenApiDescription` preserves operation parameter overrides, server choices and variables, request bodies, and
authentication alternatives. Security schemes describe advertised requirements; they do not establish that InFlow can
obtain those credentials. Server entries retain their reference base for request preparation. Local JSON pointers and up
to eight external HTTPS documents are resolved for Path Items, parameters, request bodies and security schemes;
reference chains are limited to sixteen links. Schema trees are retained, not compiled or recursively expanded.
Unsupported callback/webhook listeners, non-JSON bodies and complex parameter schemas are identified explicitly. This is
not a JSON Schema validator or an operation executor. Reference siblings other than summary/description and optional
`x-` extensions are rejected rather than silently discarded.

Public fetching permits HTTPS only, rejects credentials and non-public IP/DNS destinations, checks every redirect, and
has a fifteen-second retrieval deadline. It sends no platform authentication, cookies, proxy credentials or payment
data. Custom `PublicSourceDocuments` transports and caches are trusted embedding dependencies and must preserve these
guarantees.

For OpenAPI execution, `prepareOpenApiRequest(document, input)` constructs a request without sending it;
`previewOpenApiRequest` redacts recognized credentials for display. `callOpenApiOperation(document, input)` sends one
request unless the operation advertises payment, in which case it returns payment handoffs without invocation. Runtime
402 and AEP challenges also return explicit handoffs. It neither pays nor obtains credentials automatically. Responses
are bounded; redirects and retries are disabled. These helpers are not resource handles: callers must use `sanitizeDeep`
before rendering remote content, as the CLI does. See the
[CLI call contract](../cli/README.md#call-an-openapi-operation) for outputs and failures.

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

for await (const service of inflow.odp.searchServices({ query: 'gpu' }).items) {
  console.log(service.service_origin, service.name);
}

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

ODP directory operations and Service-document inspection use the `Inflow` instance's base transport. Applications that
support authenticated catalogs can derive a Service-scoped resource with a separate transport:

```ts
const authenticatedOdp = inflow.odp.withServiceTransport({
  transport: authenticatedFetch,
  cachePartition: 'current-principal',
});

const offering = await authenticatedOdp.service({ serviceUrl: 'https://service.example' }).getOffering('offering-id');
```

The application owns authentication and the partition value; the partition must be stable for one access context and
must not contain credential material. A custom Service transport without a partition disables catalog caching. Public
directory and inspection traffic remains on the base transport in either case.

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

Seller SDK credentials are a separate concern. A Seller API key is required by the seller configuration endpoints in
`inflow-node`; a Developer account key does not authorize those endpoints. The headless CLI client primarily models
buyer authentication and should not be used as a replacement seller SDK.

## Network

Set `INFLOW_HTTP_PROXY` to route every outbound HTTP request through a proxy. The SDK lazy-loads `undici`'s `ProxyAgent`
on first use; install it as a peer (`npm install undici`) when the env var is set. The proxy is ignored when the caller
passes a custom `fetch` — bring your own dispatcher in that case.

## Boundary

This package is the headless contract. It must not import any CLI-rendering library (`react`, `ink`, `incur`, etc.). The
repo's ESLint config has a `no-restricted-imports` rule scoped to `packages/core/src/**` that fails the lint step on any
such import. Add new bans there when promoting more CLI-only deps.

The CLI binary (`@inflowpayai/inflow`) is the only sanctioned consumer today; the package is workspace-internal
(`private: true` in `package.json`).
