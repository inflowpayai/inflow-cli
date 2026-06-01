# @inflowpayai/inflow

The InFlow binary — agentic [MPP](https://mpp.dev) / [x402](https://x402.org) payments from your machine. See the
[repository README](../../README.md) for project-level context.

Every command supports a TTY rendering (Ink) and an agent rendering via `--format <json|toon|yaml|md|jsonl>`. The TTY
view is what you get by default in an interactive terminal; the structured formats are what an AI assistant or pipeline
should request.

## Command index

| Command                              | Purpose                                                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `inflow auth login`                  | Run the OAuth device flow to authenticate. Saves a refreshable access token.                                                    |
| `inflow auth logout`                 | Clear the saved access token and API key from local config.                                                                     |
| `inflow auth status`                 | Show which credential the CLI would use, plus the active environment and resolved API URL.                                      |
| `inflow user get`                    | Fetch the authenticated user's profile.                                                                                         |
| `inflow balances list`               | List the authenticated user's balances.                                                                                         |
| `inflow deposit-addresses list`      | List the user's configured deposit addresses, grouped by network.                                                               |
| `inflow x402 pay <url>`              | Probe a seller; if it returns 402, drive the approval flow and replay the request with the signed `PAYMENT-SIGNATURE`.          |
| `inflow x402 inspect <url>`          | Read-only probe. Show the seller's `PAYMENT-REQUIRED` accepts for a URL — no auth, no payment.                                  |
| `inflow x402 status <transactionId>` | Poll the signing state of an in-flight transaction. Used to resume a previous `pay` across CLI invocations.                     |
| `inflow x402 cancel <approvalId>`    | Best-effort cancel of an in-flight approval. Always reports success.                                                            |
| `inflow x402 decode <header>`        | Decode a raw `PAYMENT-REQUIRED` header value. No auth required.                                                                 |
| `inflow x402 supported`              | List the buyer-side `(scheme, network)` capability cache.                                                                       |
| `inflow mpp pay <url>`               | Probe a seller; if it returns a `WWW-Authenticate: Payment` 402, fulfil the challenge and replay with `Authorization: Payment`. |
| `inflow mpp inspect <url>`           | Read-only probe. Parse the seller's MPP `Payment` challenge(s) for a URL — no auth, no payment.                                 |
| `inflow mpp status <transactionId>`  | Poll the buyer-side state of an in-flight MPP transaction. Used to resume a previous `pay` across CLI invocations.              |
| `inflow mpp cancel <approvalId>`     | Best-effort cancel of an in-flight MPP approval. Always reports success.                                                        |
| `inflow mpp decode <value>`          | Decode a `WWW-Authenticate: Payment` header, or a base64url credential / receipt. No auth required.                             |
| `inflow mpp supported`               | List the methods the buyer can pay with — by intent, settlement rail, and currency.                                             |

## Global flags

These flags are pre-extracted from `process.argv` before subcommand dispatch, so they work positionally —
`inflow --sandbox balances list` is the same as `inflow balances list --sandbox`. Resolution order for each setting is:
**CLI flag > environment variable > saved config > built-in default**.

| Flag                                         | Env var                | Notes                                                                                                                                                                                                                                                                              |
| -------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--api-key <key>`                            | `INFLOW_API_KEY`       | Use an API key instead of the saved OAuth access token. When both are present, the flag wins for this invocation; `auth login` persists what it saw.                                                                                                                               |
| `--environment <production\|sandbox>`        | `INFLOW_ENVIRONMENT`   | Selects the public environment. Defaults to `production`.                                                                                                                                                                                                                          |
| `--sandbox`                                  | —                      | Shorthand for `--environment sandbox`.                                                                                                                                                                                                                                             |
| `--base-url <url>` (alias: `--api-base-url`) | `INFLOW_BASE_URL`      | Override the environment-derived API URL. Takes precedence over `--environment`.                                                                                                                                                                                                   |
| `--auth-base-url <url>`                      | `INFLOW_AUTH_BASE_URL` | Override the OAuth endpoint.                                                                                                                                                                                                                                                       |
| `--auth <path>`                              | `INFLOW_AUTH_FILE`     | Path to the credentials file. Defaults to the platform's standard config dir.                                                                                                                                                                                                      |
| `--format <json\|toon\|yaml\|md\|jsonl>`     | —                      | Agent rendering. Default is TTY (Ink).                                                                                                                                                                                                                                             |
| `--verbose`                                  | —                      | Log every HTTP request/response to stderr.                                                                                                                                                                                                                                         |
| `--skill`                                    | —                      | Print the bundled `agentic-payments` skill body to stdout and exit. No frontmatter. Use for piping into a system prompt on MCP hosts that don't natively load skills: `inflow --skill \| pbcopy`.                                                                                  |
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

## `user`

### `user get`

```bash
inflow user get
inflow user get --format json
```

Fetches the authenticated user's profile (`GET /v1/users/self`). Requires authentication.

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

## `x402`

The `x402` command group drives the buyer-side of the [x402 protocol](https://x402.org). It wraps
`@inflowpayai/x402-buyer`'s two-phase signing flow with both TTY and agent renderings.

### `x402 pay`

```bash
inflow x402 pay https://seller.example.com/api/widgets
```

Probes the seller. If the seller returns 2xx (no payment required) the body is returned directly. If 402, the CLI
decodes the `PAYMENT-REQUIRED` header, picks an `accepts[]` entry the InFlow buyer can sign (filtered by
`--scheme`/`--network`/`--asset`/`--asset-name` if set, then routed by the buyer's preferred-scheme order), creates the
transaction + approval, surfaces the approval URL, waits for the user to approve, then replays the protected request
with the signed `PAYMENT-SIGNATURE` header.

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

Yields once with the approval URL and a `_next.command` hint, then exits. The agent presents the URL to the user, waits
for them to approve, then calls `x402 status` to retrieve the signed payload and replays the request itself.

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
    "command": "x402 status txn_... --interval 5 --max-attempts 60",
    "poll_interval_seconds": 5,
    "until": "encoded_payload is present",
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

Polls the signing state of an in-flight transaction. Use to resume a previous `pay` across CLI invocations — once
`status` reports `encoded_payload`, the caller replays the protected request itself, setting the encoded payload as the
`PAYMENT-SIGNATURE` header.

### `x402 cancel`

```bash
inflow x402 cancel appr_abc123
```

Best-effort cancel of `POST /v1/approvals/{approvalId}/cancel`. Always reports success — the server-side approval may
have already terminated; the SDK does not observe the difference.

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

| Code                      | When                                                                                                                                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NOT_AUTHENTICATED`       | No saved device token and no `--api-key`. (Not raised by `inspect` or `decode` — both are auth-free.)                                                                                                                     |
| `INVALID_HEADER`          | A `--header` flag wasn't in `Name: Value` form.                                                                                                                                                                           |
| `INVALID_402`             | Seller returned 402 without a `PAYMENT-REQUIRED` header.                                                                                                                                                                  |
| `DECODE_FAILED`           | Header parse failed.                                                                                                                                                                                                      |
| `UNEXPECTED_PROBE_STATUS` | Seller returned a non-2xx, non-402 status during the probe (e.g. 3xx, 4xx other than 402, 5xx). Raised by `pay` and `inspect`.                                                                                            |
| `NO_INFLOW_MATCH`         | Seller's accepts list has no InFlow-signable entry.                                                                                                                                                                       |
| `NO_FILTERED_MATCH`       | `--scheme` / `--network` / `--asset` / `--asset-name` excluded every `accepts[]` entry. The message lists each advertised entry's scheme/network plus its `asset=…` and `name=…` (when set) so the user can fix the flag. |
| `INVALID_PAYMENT_ID`      | `--payment-id` didn't satisfy the format rules.                                                                                                                                                                           |
| `APPROVAL_FAILED`         | The approval terminated without an encoded payload.                                                                                                                                                                       |
| `APPROVAL_TIMEOUT`        | The approval didn't sign before `--timeout` elapsed.                                                                                                                                                                      |
| `APPROVAL_CANCELLED`      | The approval was cancelled.                                                                                                                                                                                               |
| `PAYMENT_NOT_ACCEPTED`    | The seller still returned non-2xx on the replayed (PAYMENT-SIGNATURE-bearing) request. The approval completed but the seller did not honour the payment.                                                                  |
| `POLLING_TIMEOUT`         | `x402 status --interval` exhausted its budget before the transaction settled. Retryable.                                                                                                                                  |
| `INSPECT_FAILED`          | Transport-layer failure during `x402 inspect` (DNS, connection refused, etc.).                                                                                                                                            |

## `mpp`

The `mpp` command group is the MPP analog of `x402`, for sellers that answer `402` with `WWW-Authenticate: Payment …`
(the MPP `Payment` auth scheme) instead of x402's `PAYMENT-REQUIRED`. It is built on `@inflowpayai/mpp`'s `MppClient`
and mirrors `x402` command-for-command — `pay`, `inspect`, `status`, `cancel`, `decode`, `supported` — with the same
TTY + agent renderings, the same two-process approval handoff, and the same `--output-file` / `--format` behaviour.

```bash
inflow mpp inspect <url>                                    # parse the seller's Payment challenge(s) — read-only
inflow mpp pay <url> --interval 5 --max-attempts 60         # fast path: create -> poll -> replay -> return body
inflow mpp pay <url> --format json                          # two-process: returns transaction_id + a `mpp status` _next hint
inflow mpp status <transactionId> --interval 5              # resume an in-flight transaction; ready frames carry `credential`
inflow mpp cancel <approvalId>                              # best-effort cancel of a pending approval
inflow mpp decode '<WWW-Authenticate: Payment value>'       # or a base64url credential / receipt
inflow mpp supported                                        # methods the buyer can pay with: method -> intent -> rail -> currencies
```

Differences from `x402`:

- The seller's challenge pins the settlement rail, so the buyer does not choose a scheme/network/asset the way x402
  does. Instead the buyer narrows _which advertised challenge_ to fulfil (see the flags below), then optionally names a
  funding instrument.
- `pay` (when ready) and `status` surface a base64url `credential`; replay the request with
  `Authorization: Payment <credential>`. `--credential-file <path>` writes it at mode `0o600` and the frame carries
  `credential_saved_to` instead of `credential` — the analog of x402's `--payload-file` / `encoded_payload`.
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
only when stdout is a TTY and no `--format` is explicitly set.
