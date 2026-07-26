# @inflowpayai/inflow

The InFlow binary — Agent Enrollment Protocol access and agentic [MPP](https://mpp.dev) / [x402](https://x402.org)
payments from your machine. See the [repository README](../../README.md) for project-level context.

Install InFlow from [inflowcli.ai](https://inflowcli.ai/) to run commands, start MCP, or manage credentials.

Every command supports a TTY rendering (Ink) and an agent rendering via `--format <json|toon|yaml|md|jsonl>`. The TTY
view is what you get by default in an interactive terminal; the structured formats are what an AI assistant or pipeline
should request.

For host-specific skill and MCP installation, see the repository's
[surface install and testing guide](https://github.com/inflowpayai/inflow-cli/blob/main/docs/development/surfaces-and-testing.md).

## Command index

| Command                              | Purpose                                                                                                                           |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `inflow auth login`                  | Run the OAuth device flow to authenticate. Saves a refreshable access token.                                                      |
| `inflow auth logout`                 | Clear the saved access token and API key from local config.                                                                       |
| `inflow auth status`                 | Show which credential the CLI would use, plus the active environment and resolved API URL.                                        |
| `inflow balances list`               | List the authenticated user's balances.                                                                                           |
| `inflow deposit-addresses list`      | List the user's configured deposit addresses, grouped by network.                                                                 |
| `inflow inspect <url>`               | Detect a URL's payment protocol(s) and show MPP and x402 challenges together. Read-only probe — no auth, no payment.              |
| `inflow aep inspect <service>`       | Inspect an Agent Enrollment Protocol Service. No InFlow login is required.                                                        |
| `inflow aep fetch <resource-url>`    | Fetch a resource anonymously or complete AEP authentication, approval, credential storage, and replay in one invocation.          |
| `inflow aep enroll <service>`        | Provision or reuse a Service-scoped Agent identity and enroll after InFlow approval.                                              |
| `inflow aep status <service>`        | Fetch Service lifecycle status and list non-secret local credential summaries.                                                    |
| `inflow aep grant <service>`         | Request a fresh Service credential and store it locally without exposing its secret.                                              |
| `inflow aep revoke <service>`        | Revoke all Service credentials, or one credential or grant type.                                                                  |
| `inflow x402 pay <url>`              | Create an x402 payment transaction and optionally poll/replay inline.                                                             |
| `inflow x402 fetch <tx> <url>`       | Resume an x402 transaction, wait for a signed payload when configured, and fetch the seller resource.                             |
| `inflow x402 inspect <url>`          | Read-only probe. Show the seller's `PAYMENT-REQUIRED` accepts for a URL — no auth, no payment.                                    |
| `inflow x402 status <transactionId>` | Poll the signing state of an in-flight transaction without contacting the seller.                                                 |
| `inflow x402 cancel <approvalId>`    | Best-effort cancel of an in-flight approval. Requires authentication; success does not verify the server-side approval state.     |
| `inflow x402 decode <header>`        | Decode a raw `PAYMENT-REQUIRED` header value. No auth required.                                                                   |
| `inflow x402 supported`              | List the buyer-side `(scheme, network)` capability cache.                                                                         |
| `inflow mpp pay <url>`               | Create an MPP payment transaction and optionally poll/replay inline.                                                              |
| `inflow mpp fetch <tx> <url>`        | Resume an MPP transaction, wait for a ready credential when configured, and fetch the seller resource.                            |
| `inflow mpp inspect <url>`           | Read-only probe. Parse the seller's MPP `Payment` challenge(s) for a URL — no auth, no payment.                                   |
| `inflow mpp status <transactionId>`  | Poll the buyer-side state of an in-flight MPP transaction without contacting the seller.                                          |
| `inflow mpp cancel <approvalId>`     | Best-effort cancel of an in-flight MPP approval. Requires authentication; success does not verify the server-side approval state. |
| `inflow mpp decode <value>`          | Decode a `WWW-Authenticate: Payment` header, or a base64url credential / receipt. No auth required.                               |
| `inflow mpp supported`               | List the methods the buyer can pay with — by intent, settlement rail, and currency.                                               |

## Global flags

These flags are pre-extracted from `process.argv` before subcommand dispatch, so they work positionally —
`inflow --sandbox balances list` is the same as `inflow balances list --sandbox`. Resolution order for each setting is:
**CLI flag > environment variable > saved config > built-in default**.

| Flag                                         | Env var                | Notes                                                                                                                                                                                                                                                                              |
| -------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--api-key <key>`                            | `INFLOW_API_KEY`       | Use an API key instead of the saved OAuth access token. When both are present, the flag wins for this invocation; `auth login` persists what it saw.                                                                                                                               |
| `--auth <path>`                              | `INFLOW_AUTH_FILE`     | Path to the credentials file. Defaults to the platform's standard config dir.                                                                                                                                                                                                      |
| `--auth-base-url <url>`                      | `INFLOW_AUTH_BASE_URL` | Override the OAuth endpoint.                                                                                                                                                                                                                                                       |
| `--base-url <url>` (alias: `--api-base-url`) | `INFLOW_BASE_URL`      | Override the environment-derived API URL. Takes precedence over `--environment`.                                                                                                                                                                                                   |
| `--bootstrap`                                | —                      | Print the agent setup guide (install, authenticate, load a playbook) to stdout and exit. The same text is served at `https://inflowcli.ai/skill.md`.                                                                                                                               |
| `--environment <production\|sandbox>`        | `INFLOW_ENVIRONMENT`   | Selects the public environment. Defaults to `production`.                                                                                                                                                                                                                          |
| `--format <json\|toon\|yaml\|md\|jsonl>`     | —                      | Agent rendering. Default is TTY (Ink).                                                                                                                                                                                                                                             |
| `--sandbox`                                  | —                      | Shorthand for `--environment sandbox`.                                                                                                                                                                                                                                             |
| `--skill [name]`                             | —                      | Print a bundled skill body to stdout and exit. Available skills are `agentic-enrollment` and `agentic-payments`; the default is `agentic-payments`. No frontmatter. Use for piping into a system prompt on MCP hosts that don't natively load skills.                              |
| `--verbose`                                  | —                      | Log every HTTP request/response to stderr.                                                                                                                                                                                                                                         |
| —                                            | `INFLOW_HTTP_PROXY`    | Route every outbound HTTP request through this proxy URL. Requires the optional `undici` peer (`npm install undici`); the SDK throws `InflowConfigurationError` at first request when the env var is set but `undici` is missing. Ignored when the caller passes a custom `fetch`. |

## `auth`

The CLI authenticates via the OAuth device-authorization flow. After `auth login` completes, the access + refresh tokens
are stored in the platform's standard config dir (or wherever `--auth` / `INFLOW_AUTH_FILE` points). The `inflow-core`
access-token provider refreshes automatically when the access token expires.

API keys are an alternative: pass `--api-key` or set `INFLOW_API_KEY` once and the CLI sends `X-API-KEY` on every
request, bypassing the device flow entirely. Mutually exclusive with the OAuth path on a given invocation.

### `auth login`

```bash
# TTY: prompts you, opens the browser, polls until you approve.
inflow auth login

# Agent (two-process): returns the verification URL and a follow-up command.
inflow auth login --format json

# Agent (inline poll): blocks until the device flow terminates.
inflow auth login --format json --interval 5 --max-attempts 60
```

The OAuth verification URL is opened with the platform's default browser launcher (`open` on macOS, `xdg-open` on Linux,
`cmd /c start "" <url>` on Windows). On Linux this requires a working `DISPLAY` or an installed default-handler — when
the launcher is unavailable (headless containers, locked-down terminals), the CLI silently falls back to printing the
URL. Paste it into a browser by hand to continue.

### `auth logout`

```bash
inflow auth logout
```

Clears the saved access token, refresh token, and any saved `--api-key` from local config. Idempotent: safe to call when
already logged out.

### `auth status`

```bash
inflow auth status              # TTY
inflow auth status --format json
inflow auth status --probe      # validate the token via GET /v1/users/self
```

Reports which credential the CLI would use (OAuth access token, API key, or none), the active environment, and the
resolved API URL — including the SDK's built-in defaults when nothing is overridden.

## `balances`

### `balances list`

```bash
inflow balances list
inflow balances list --format json
```

TTY renders a `Currency`/`Available` table. Agent format yields the raw balance array.

## `deposit-addresses`

### `deposit-addresses list`

```bash
inflow deposit-addresses list
inflow deposit-addresses list --format json
```

Lists the configured deposit addresses for the authenticated user. TTY groups by network with a deposit address per row.

## `aep`

The `aep` group implements six Agent Enrollment Protocol Service commands. `inspect` is stateless and works logged out.
The other commands use the existing InFlow authentication session to authenticate to the InFlow Platform; the
Platform-issued AEP assertion separately authenticates the Agent to the Service.

```bash
inflow aep inspect service.example
inflow aep inspect https://service.example/private --method GET
inflow aep fetch https://service.example/private --format json
inflow aep enroll service.example --interval 5
inflow aep status service.example --format json
inflow aep grant service.example --scope read:resource
inflow aep revoke service.example
```

The CLI stores Service-scoped identities and complete credential material in the existing mode-`0o600` credentials file.
Stored state belongs to the canonical InFlow Platform origin and authenticated user. Logout clears it. Agent output
never exposes credential secrets: `grant` reports only credential metadata, and `status` reports only usable local grant
summaries.

`aep inspect` probes an exact URL when one is supplied and reports `resource_authentication` as `not-required`,
`aep-authenticatable`, or `other-authentication-required`. DID input reports `not-checked`. Service discovery remains
origin-based. `enroll` returns the complete validated Service response. `status` returns
`{ service, local: { grants } }`; when the Agent is not enrolled, it returns
`{ enrolled: false, service: null, local: { grants: [] } }`. `grant` returns `granted`, credential metadata, and scopes;
`revoke` returns `revoked` and its single selector field.

`aep fetch` preserves the original method, headers, replayable body, redirect and response bounds, and output controls.
When authenticated AEP access reaches a legitimate payment `402`, the command exits successfully with
`payment_required.protocols` and copyable `payment_required.commands` so callers can continue with `mpp pay` or
`x402 pay`; it never creates a payment transaction itself.

## `inspect`

```bash
inflow inspect https://seller.example.com/api/widgets
```

Protocol-agnostic, read-only pre-flight. It decodes AEP, MPP, and x402 requirements without creating AEP Grant, AEP Sign
approval, or payment. When a fresh OpenAPI policy proves AEP authentication is required, `inspect` stops at the AEP gate
unless a compatible stored AEP session credential can reveal the downstream payment layer. Otherwise it probes the URL
once and decodes both MPP and x402 challenges from the same 402 response — so you don't have to know the protocol before
inspecting. **No authentication required.** This is the recommended first step: read `detected` to decide which rail
owns the next action.

Unlike the per-protocol probes it carries only the probe-shape flags (`--method`, `--data`, `--header`) — it is
deliberately unfiltered. For filtered probes or full per-protocol detail (pay-to, timeout, extras, challenge ids /
digests), use [`inflow mpp inspect`](#mpp-inspect) / [`inflow x402 inspect`](#x402-inspect).

TTY renders a `detected:` summary line, then one section per protocol. Each section shows a triage table or a dim "none
advertised" line; a protocol whose header is present but undecodable shows a one-line warning rather than failing the
command. The x402 `Amount` is the seller's raw atomic units (decimals are not carried on the wire), and `Asset` is the
full on-chain contract address / mint rendered verbatim — it is not a token symbol.

```
PAYMENT-REQUIRED for https://seller.example.com/api/widgets  ·  detected: mpp, x402

── MPP ──  WWW-Authenticate: Payment  ·  realm mpp.example  ·  1 challenge
Method  Intent  Amount  Currency  Rail
------  ------  ------  --------  -------
inflow  charge  0.10    USDC      balance

── x402 ──  PAYMENT-REQUIRED  ·  x402Version 2  ·  2 accepts
Scheme  Network                                  Amount  Asset
------  ---------------------------------------  ------  ------------------------------------------
exact   eip155:84532                             10000   0x036CbD53842c5426634e7929541eC2318f3dCF7e
exact   solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1  10000   4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU

Full detail (pay-to, timeout, extras, ids/digests): `inflow mpp inspect` / `inflow x402 inspect`, or --format json.
```

Agent shape — fixed-shape arrays (`mpp` / `x402` are `[]` when a protocol is absent), with `detected` listing the
protocols that have at least one entry:

```jsonc
{
  "outcome": "inspected",
  "url": "https://seller.example.com/api/widgets",
  "method": "GET",
  "detected": ["x402"],
  "aep": { "required": false, "source": "anonymous_probe" },
  "mpp": [],
  "x402": [
    {
      "scheme": "exact",
      "network": "eip155:84532",
      "amount": "10000",
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "pay_to": "0x2096...",
      "max_timeout_seconds": 300,
      "extra": { "name": "USDC", "version": "2" },
    },
  ],
  "x402_resource": "https://www.seller.example.com/api/widgets",
  "x402_version": 2,
}
```

Section-level problems are surfaced (without failing the command) in an optional `warnings` array — for example an MPP
header advertising no inflow-payable challenge (`NO_INFLOW_MATCH`), a present-but-undecodable header (`DECODE_FAILED`),
or a 402 carrying neither protocol header (`NO_PAYMENT_CHALLENGE`). If AEP authentication blocks payment inspection, the
successful JSON frame includes `aep.blocked: true`, `aep.source: "openapi"`, and a warning with code
`AEP_PAYMENT_INSPECT_BLOCKED`; it does not claim MPP or x402 were observed.

When the seller returns 2xx (no payment required), `inspect` yields `outcome: "no-payment-required"` with `status`,
`content_type`, and `body_size_bytes` — never the body itself.

## `x402`

The `x402` command group drives the buyer-side of the [x402 protocol](https://x402.org). It wraps
`@inflowpayai/x402-buyer`'s two-phase signing flow with both TTY and agent renderings.

### `x402 pay`

```bash
inflow x402 pay https://seller.example.com/api/widgets
```

Probes the seller. If the seller first returns an AEP `401`, the CLI completes AEP authentication before looking for the
payment `402`. If the seller returns 2xx (no payment required) the body is returned directly. If 402, the CLI decodes
the `PAYMENT-REQUIRED` header, picks an `accepts[]` entry the InFlow buyer can sign (filtered by
`--scheme`/`--network`/`--asset`/`--asset-name` if set, then routed by the buyer's preferred-scheme order), creates the
transaction + approval, surfaces the approval URL, waits for the user to approve, then replays the protected request
with the AEP credential and signed `PAYMENT-SIGNATURE` header when both are required.

#### Useful flags

| Flag                             | Default | Notes                                                                                                                                                                                                                                          |
| -------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--method <verb>`                | `GET`   | HTTP method for the seller request.                                                                                                                                                                                                            |
| `--data <body>`                  | —       | Request body. Sets `Content-Type: application/json` unless a `--header` overrides it.                                                                                                                                                          |
| `--header <"Name: Value">`       | —       | Repeatable. Forwarded on both the probe and the replay.                                                                                                                                                                                        |
| `--scheme <scheme>`              | —       | Constrain the picked `accepts[]` entry to a specific scheme (e.g. `balance`, `exact`).                                                                                                                                                         |
| `--network <network>`            | —       | Constrain the picked `accepts[]` entry to a specific network (e.g. `inflow:1`, `eip155:84532`, `solana:...`).                                                                                                                                  |
| `--asset <asset>`                | —       | Constrain the picked `accepts[]` entry to a specific on-chain asset identifier (ERC-20 contract address for EVM, mint pubkey for SVM).                                                                                                         |
| `--asset-name <name>`            | —       | Constrain the picked `accepts[]` entry by its `extra.assetName` — the human-readable symbol the seller advertises (e.g. `USDC`). Distinct from `extra.name` (the EIP-712 domain, e.g. `USD Coin`); matches the symbol, not the on-chain asset. |
| `--interval <seconds>`           | `0`     | Inline poll cadence while awaiting approval. `0` returns the approval URL and a follow-up command hint without blocking.                                                                                                                       |
| `--max-attempts <n>`             | `0`     | Hard cap on poll attempts when `--interval > 0`. `0` is unlimited.                                                                                                                                                                             |
| `--timeout <seconds>`            | `900`   | Polling deadline. Matches `@inflowpayai/x402-buyer`'s default approval expiry.                                                                                                                                                                 |
| `--payment-id <id>`              | —       | Caller-supplied payment identifier (16–128 chars, `^[a-zA-Z0-9_-]+$`). Forwarded to the server as `remotePaymentId`.                                                                                                                           |
| `--show-body` / `--no-show-body` | `true`  | Include the seller response body inline in the result. Default suits AI assistants paying for content.                                                                                                                                         |
| `--output-file <path>`           | —       | Write the seller response body bytes to disk (overwrites silently) and surface `output_saved_to: <abs-path>` instead of `body` / `body_base64`. Natural for binary downloads. Pair with `--no-show-body`.                                      |
| `--payload-file <path>`          | —       | Write the signed `encoded_payload` bytes to disk (mode `0o600`, overwrites silently) and surface `payload_saved_to: <abs-path>` instead of `encoded_payload`. Keeps one-time payment credentials out of chat transcripts and logs.             |

#### TTY example

```bash
inflow x402 pay https://seller.example.com/api/widgets
```

Renders a spinner while probing, a labeled box with the approval URL once the seller returns 402, then the replayed
response metadata on success.

#### Agent example — without `--interval` (two-process pattern)

```bash
inflow x402 pay https://seller.example.com/api/widgets --format json
```

Yields once with the approval URL and a `_next` Fetch continuation, then exits. The agent presents the URL to the user,
then calls `x402 fetch` to wait for the signed payload and fetch the seller resource.

```jsonc
{
  "transaction_id": "txn_...",
  "approval_id": "appr_...",
  "approval_url": "https://app.inflowpay.ai/approvals/appr_.../view/",
  "amount": "500",
  "asset": "USDC",
  "resource": "https://seller.example.com/api/widgets",
  "scheme": "balance",
  "network": "inflow:1",
  "instruction": "Present the approval_url to the user ...",
  "_next": {
    "command": "x402 fetch txn_... https://seller.example.com/api/widgets --interval 5 --max-attempts 60",
    "tool": "x402_fetch",
    "input": {
      "transactionId": "txn_...",
      "resourceUrl": "https://seller.example.com/api/widgets",
      "method": "GET",
      "header": [],
      "interval": 5,
      "maxAttempts": 60,
      "timeout": 900,
      "showBody": true,
    },
    "poll_interval_seconds": 5,
    "until": "resource fetch completes",
  },
}
```

#### Agent example — with `--interval` (inline poll)

```bash
inflow x402 pay https://seller.example.com/api/widgets --format json --interval 5
```

Yields the initial frame (without `_next.command`), then polls inline; the final frame contains the signed
`encoded_payload`, the replayed response metadata, and any settled-via fields decoded from the seller's
`PAYMENT-RESPONSE` header.

#### POST with a body

```bash
inflow x402 pay https://seller.example.com/api/post \
  --method POST --data '{"amount": 100}' --header 'X-Trace: 42'
```

`--data` sets `Content-Type: application/json` unless overridden via `--header`.

#### Constrain the selected accepts entry

```bash
inflow x402 pay https://seller.example.com/api/widgets \
  --scheme exact --network eip155:84532 \
  --asset 0x833589fcd6edb6e08f4c7c32d4f71b54bda02913 --asset-name "USD Coin"
```

`--scheme`, `--network`, `--asset`, and `--asset-name` are independent and AND-combined: each one that's set narrows the
seller's `accepts[]` further. `--asset` matches the on-chain asset identifier; `--asset-name` matches the
seller-declared `extra.assetName` symbol (e.g. `USDC`) — not `extra.name`, which is the EIP-712 domain (e.g.
`USD Coin`). When the resulting set is empty the command fails with `NO_FILTERED_MATCH` and the message reports the
scheme/network/asset/name tuples the seller actually advertises. When a match exists but the buyer-side cache can't sign
it, the existing `NO_INFLOW_MATCH` still fires — filtering and routing are orthogonal.

### `x402 inspect`

```bash
inflow x402 inspect https://seller.example.com/api/widgets
```

Read-only pre-flight. Probes the URL exactly the way `pay` does, but stops at the decode step — no signer, no approval,
no replay. Useful for surfacing the seller's prices and network choices to a user (or to an agent that wants to pick a
`--scheme`/`--network` before committing). **No authentication required.**

TTY renders a table with proper-cased headers — `Scheme`, `Network`, `Amount`, `Asset`, `Pay To`, `Timeout`, `Extra` —
with `Pay To` rendered verbatim (no truncation). The `Extra` column shows the comma-separated keys of the
scheme-specific `extra` record (e.g. `assetName, name, version, assetTransferMethod` for EIP-3009, where `assetName` is
the symbol `--asset-name` matches on); pass `--format json` to see the values.

```
PAYMENT-REQUIRED for https://seller.example.com/api/widgets  ·  x402Version 2  ·  3 accepts

Scheme   Network                                      Amount  Asset  Pay To                                       Timeout  Extra
-------  -------------------------------------------  ------  -----  -------------------------------------------  -------  -----------------------------------
balance  inflow:1                                     500     USDC   inflow:abc                                   60s      —
exact    eip155:84532                                 500     USDC   0xAbCdEfABcDef0123456789aBcDeF0123456789aB   60s      assetName, name, version, assetTransferMethod
exact    solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1      500     USDC   sol-payto                                    60s      —

Use --format json to inspect extras values.
```

Agent shape:

```jsonc
{
  "outcome": "accepts",
  "url": "https://seller.example.com/api/widgets",
  "method": "GET",
  "resource": "https://seller.example.com/api/widgets",
  "x402_version": 2,
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:84532",
      "amount": "500",
      "asset": "USDC",
      "pay_to": "0xabc...",
      "max_timeout_seconds": 60,
      "extra": { "assetName": "USDC", "name": "USD Coin", "version": "2", "assetTransferMethod": "eip3009" },
    },
  ],
}
```

When the seller returns 2xx (no payment required), `inspect` yields `outcome: "no-payment-required"` with `status`,
`content_type`, and `body_size_bytes` — but never the body itself. Use `x402 pay` if you want the body.

Supports the same probe-shape flags as `pay` (`--method`, `--data`, `--header`) and the same filter flags (`--scheme`,
`--network`, `--asset`, `--asset-name`).

### `x402 status`

```bash
inflow x402 status txn_abc123
inflow x402 status txn_abc123 --interval 5 --max-attempts 60
inflow x402 status txn_abc123 --format json
```

Polls the signing state of an in-flight transaction. It never contacts the seller. Use `x402 fetch` to complete the
seller request.

### `x402 fetch`

```bash
inflow x402 fetch txn_abc123 https://seller.example.com/api/widgets --interval 5 --max-attempts 60
```

Loads the transaction state, waits for a signed payload when `--interval` is set, completes any required AEP
authentication, and sends one credential-bearing seller replay with `PAYMENT-SIGNATURE` plus a non-colliding AEP
credential when needed. Terminal declined, cancelled, failed, and expired states stop before seller contact. Fetch
output never exposes the encoded payload or AEP credential material.

### `x402 cancel`

```bash
inflow x402 cancel appr_abc123
```

Best-effort cancel of `POST /v1/approvals/{approvalId}/cancel`. Requires authentication. On success, the CLI returns
`cancelled: true`, but it does not poll for confirmation; the server-side approval may have already terminated.

### `x402 decode`

```bash
inflow x402 decode '<base64-PAYMENT-REQUIRED>'
inflow x402 decode '<base64-PAYMENT-REQUIRED>' --format json
```

Decode a raw `PAYMENT-REQUIRED` header value (typically copied out of a seller's 402 response). No auth required, no
HTTP. Use `inspect` when you only have the seller's URL and not yet the header.

### `x402 supported`

```bash
inflow x402 supported
inflow x402 supported --format json
```

Lists the buyer-side capability cache — the `(scheme, network)` pairs the authenticated user can sign for via InFlow.
Honors the SDK's 60-min cache TTL. Useful when debugging why `pay` chose one entry over another, or surfaced
`NO_INFLOW_MATCH`.

### Errors (x402 group)

The `--format json` error envelope follows the framework contract: `{ code, message, retryable? }` plus a non-zero exit
code. The `x402` group adds these codes:

| Code                             | When                                                                                                                                                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NOT_AUTHENTICATED`              | No saved device token and no `--api-key`. (Not raised by `inspect` or `decode` — both are auth-free.)                                                                                                                     |
| `INVALID_HEADER`                 | A `--header` flag wasn't in `Name: Value` form.                                                                                                                                                                           |
| `INVALID_402`                    | Seller returned 402 without a `PAYMENT-REQUIRED` header.                                                                                                                                                                  |
| `DECODE_FAILED`                  | Header parse failed.                                                                                                                                                                                                      |
| `UNEXPECTED_PROBE_STATUS`        | Seller returned a non-2xx, non-402 status during the probe (e.g. 3xx, 4xx other than 402, 5xx). Raised by `pay` and `inspect`.                                                                                            |
| `NO_INFLOW_MATCH`                | Seller's accepts list has no InFlow-signable entry.                                                                                                                                                                       |
| `NO_FILTERED_MATCH`              | `--scheme` / `--network` / `--asset` / `--asset-name` excluded every `accepts[]` entry. The message lists each advertised entry's scheme/network plus its `asset=…` and `name=…` (when set) so the user can fix the flag. |
| `INVALID_PAYMENT_ID`             | `--payment-id` didn't satisfy the format rules.                                                                                                                                                                           |
| `APPROVAL_FAILED`                | The approval terminated without an encoded payload.                                                                                                                                                                       |
| `APPROVAL_TIMEOUT`               | The approval didn't sign before `--timeout` elapsed.                                                                                                                                                                      |
| `APPROVAL_CANCELLED`             | The approval was cancelled.                                                                                                                                                                                               |
| `PAYMENT_NOT_ACCEPTED`           | The seller still returned non-2xx on the replayed (PAYMENT-SIGNATURE-bearing) request. The approval completed but the seller did not honour the payment.                                                                  |
| `PAYMENT_REPLAY_OUTCOME_UNKNOWN` | A credential-bearing seller request had an indeterminate transport failure. Do not automatically replay.                                                                                                                  |
| `POLLING_TIMEOUT`                | `x402 status --interval` exhausted its budget before the transaction settled. Retryable.                                                                                                                                  |
| `INSPECT_FAILED`                 | Transport-layer failure during `x402 inspect` (DNS, connection refused, etc.).                                                                                                                                            |

## `mpp`

The `mpp` command group is the MPP analog of `x402`, for sellers that answer `402` with `WWW-Authenticate: Payment …`
(the MPP `Payment` auth scheme) instead of x402's `PAYMENT-REQUIRED`. It is built on `@inflowpayai/mpp`'s `MppClient`
and mirrors `x402` command-for-command — `pay`, `fetch`, `inspect`, `status`, `cancel`, `decode`, `supported` — with the
same TTY + agent renderings, the same two-process approval handoff, and the same `--output-file` / `--format` behaviour.

```bash
inflow mpp inspect <url>                                    # parse the seller's Payment challenge(s) — read-only
inflow mpp pay <url> --interval 5 --max-attempts 60         # fast path: create -> poll -> replay -> return body
inflow mpp pay <url> --format json                          # two-process: returns transaction_id + a `mpp fetch` _next hint
inflow mpp fetch <transactionId> <url> --interval 5         # resume and fetch the seller resource
inflow mpp status <transactionId> --interval 5              # monitor state only; never contacts the seller
inflow mpp cancel <approvalId>                              # best-effort cancel of a pending approval
inflow mpp decode '<WWW-Authenticate: Payment value>'       # or a base64url credential / receipt
inflow mpp supported                                        # methods the buyer can pay with: method -> intent -> rail -> currencies
```

Differences from `x402`:

- The seller's challenge pins the settlement rail, so the buyer does not choose a scheme/network/asset the way x402
  does. Instead the buyer narrows _which advertised challenge_ to fulfil (see the flags below), then optionally names a
  funding instrument.
- `fetch` attaches the base64url credential as `Authorization: Payment <credential>` and never exposes it in Fetch
  output. If AEP authentication is required, the replay also carries a non-colliding AEP credential such as
  `AEP-Authorization`. `status` can still show or save the credential for diagnostics.
- A 402 carrying no `inflow`-method challenge fails with `NO_INFLOW_MATCH`.

#### Challenge-selection flags (`pay` and `inspect`)

These narrow the seller's advertised challenge set; each is independent and AND-combined. When the result is empty the
command fails with `NO_FILTERED_MATCH`. (`x402`'s `--scheme`/`--network`/`--asset`/`--asset-name` have no MPP analog —
the rail is fixed by the seller, so the buyer filters by method/intent/currency/rail instead.)

| Flag                     | Notes                                                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--payment-method <m>`   | Only consider challenges with this payment method (e.g. `inflow`).                                                                                                        |
| `--intent <intent>`      | Only consider challenges with this intent (e.g. `charge`).                                                                                                                |
| `--currency <CODE>`      | Only consider challenges in this currency (e.g. `USDC`). Disambiguates when the seller offers the `inflow` method in more than one currency.                              |
| `--rail <rail>`          | Only consider challenges on this settlement rail (e.g. `balance`, `instrument`).                                                                                          |
| `--instrument-id <uuid>` | Funding instrument id for an instrument-rail (fiat) challenge. The only option that selects _how_ to fund rather than which challenge — the rail itself is seller-pinned. |

### Errors (mpp group)

Same `--format json` envelope as `x402` (`{ code, message, retryable? }` plus a non-zero exit code). The shared
probe/decode/match codes carry the same meaning as in the `x402` table above; the rail-specific terminal codes differ:

| Code                      | When                                                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NOT_AUTHENTICATED`       | No saved device token and no `--api-key`. (Not raised by `inspect` or `decode` — both are auth-free.)                                                         |
| `INVALID_HEADER`          | A `--header` flag wasn't in `Name: Value` form.                                                                                                               |
| `INVALID_402`             | Seller returned 402 without a parseable `WWW-Authenticate: Payment` challenge.                                                                                |
| `DECODE_FAILED`           | Challenge / credential / receipt parse failed.                                                                                                                |
| `UNEXPECTED_PROBE_STATUS` | Seller returned a non-2xx, non-402 status during the probe. Raised by `pay` and `inspect`.                                                                    |
| `NO_INFLOW_MATCH`         | The 402 carried no `inflow`-method challenge the buyer can fulfil.                                                                                            |
| `NO_FILTERED_MATCH`       | `--payment-method` / `--intent` / `--currency` / `--rail` excluded every challenge. The message lists the challenges the seller actually advertised.          |
| `PAYMENT_NOT_ACCEPTED`    | The seller still returned non-2xx on the replayed (`Authorization: Payment`) request. The transaction was ready but the seller did not honour the credential. |
| `PAYMENT_FAILED`          | The transaction reached a terminal `failed` state, or the pay pipeline could not produce a credential.                                                        |
| `PAYMENT_EXPIRED`         | The transaction expired before it became ready.                                                                                                               |
| `POLLING_TIMEOUT`         | `mpp status --interval` exhausted its budget before the transaction became ready. Retryable.                                                                  |
| `INSPECT_FAILED`          | Transport-layer failure during `mpp inspect` (DNS, connection refused, etc.).                                                                                 |

## Notes

Output is intentionally machine-parseable when `--format` is set, even on the error path. AI assistants and pipelines
should always pass `--format json` (or another structured format). The TTY rendering is for humans and is the default
only when stdout is a TTY and no `--format` is explicitly set. `aep fetch`, `mpp pay`, `mpp fetch`, `x402 pay`, and
`x402 fetch` first preserve the requested method, headers, and replayable body while checking for AEP. Anonymous success
does not require an InFlow session. On an AEP challenge, the command recovers an existing Platform identity, selects a
requested or compatible stored credential or grant type, and delegates Grant, credential storage, authentication
selection, redirects, and replay to the AEP Agent SDK. Pending Grant and authenticate signing use the existing approval
view and continue inside the original invocation. Payment credentials are created only after AEP succeeds and the
seller's payment challenge is available; the final replay carries payment material exactly once.

The JSON result contains `requested_url`, `final_url`, `status`, optional `content_type`, `response_size_bytes`,
`redirects.occurred`, optional `service_did`, and `authentication` with `outcome`, `method`, and non-secret credential
or grant metadata. Response content is represented by `body`, `body_base64`, or `output_saved_to`.
