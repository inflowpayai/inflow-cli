---
version: 0.5.0
name: agentic-payments
description: Authenticate with InFlow and pay HTTP 402 (x402)-protected resources. Use when the user invokes the `inflow` CLI or asks to log in / connect to InFlow. NOT for traditional merchant checkouts (card forms, hosted checkouts) — InFlow does not provision PANs.
allowed-tools: ['Bash(inflow:*)', 'Bash(npx:*)', 'Bash(npm:*)']
user-invocable: true
license: Complete terms in LICENSE
metadata: { "author": "jarwin", "url": "app.inflowpay.ai", "openclaw": { "emoji": "💸", "homepage": "https://app.inflowpay.ai", "requires": { "bins": ["inflow"] }, "install": [{ "id": "npm", "kind": "node", "package": "@inflowpayai/inflow", "bins": ["inflow"], "label": "Install InFlow" }] } }
---

# Agentic Payments

## Installing

Install with `npm install -g @inflowpayai/inflow`. Or run directly with `npx @inflowpayai/inflow`.

## Running

InFlow runs as a **standalone CLI** or an **MCP server**.

**MCP**: add to your MCP client config:

```json
{
  "mcpServers": {
    "inflow": {
      "command": "npx",
      "args": ["-y", "@inflowpayai/inflow", "--mcp"]
    }
  }
}
```

The `-y` flag suppresses npx's confirmation prompt — without it the MCP host can stall on first run.

**MCP mode** exposes every CLI command as a tool. Call `tools/list` on the MCP server for the authoritative inventory; arguments mirror the CLI flags one-to-one.

### Common commands / options

- `inflow --llms` (or `--llms-full` for parameter detail) — discover all commands. `inflow <command> --schema` for a single command's JSON Schema.
- `inflow --skill` — print this playbook (no frontmatter) to stdout. Use it to paste into the system-prompt field of an MCP host that doesn't natively load skills: `inflow --skill | pbcopy`.
- Default output is `toon`. Override with `--format <fmt>`; for programmatic parsing prefer `json` (single document) or `jsonl` (line-delimited). `inflow <command> --schema` enumerates every option for the command.
- Multi-step flows return `_next.command` — run it to continue.
- `--auth <path>` overrides the credentials file location.
- `--api-key <key>` or `INFLOW_API_KEY=<key>` is an alternative to device-flow auth.

## Core flow

**Sequencing.** Run the steps in order. Don't skip ahead — Step 3 fails or double-charges if Steps 1-2 didn't clear. `x402 inspect` and `x402 decode` are read-only and don't require auth, so they may run before Step 1 if useful (e.g. when sizing up a paywall before committing the user to a login).

Copy this checklist and track progress:

- Step 1: Authenticate with InFlow.
- Step 2: Pre-flight evaluation (probe seller, check supported pairs, check balance).
- Step 3: Pay via x402.

### Step 1: Authenticate

Check the current state first — the user may already be logged in:

```bash
inflow auth status
```

Authenticated response shape (`access_token` is a 20-char preview, not the full token):

```json
{
  "authenticated": true,
  "auth_method": "device_token",
  "access_token": "inf_3LtKpQ7nWxYzA1bC...",
  "credentials_path": "/Users/.../inflow/auth.json",
  "connection": { "environment": "production", "apiBaseUrl": "https://api.inflowpay.ai" },
  "update": { "current": "0.4.6", "latest": "0.5.1" }
}
```

`auth_method` is `device_token` or `api_key`. For the user's identity (email, handle, account id), call `inflow user get` — `auth status` deliberately doesn't include it.

If the response includes an `update` field, a newer version of `inflow` is published.

**Surface and defer.** Tell the user a newer version is available and how to upgrade — `npm install -g @inflowpayai/inflow@latest` (or `npx @inflowpayai/inflow@latest`). Then **proceed with the current version**. Only block on the upgrade if a subsequent command fails with `VERSION_UNSUPPORTED` (or an HTTP 426 from the API), at which point the upgrade is mandatory and you should not retry until it lands.

If `authenticated` is `false`, start the device flow:

```bash
inflow auth login --client-name "<your-agent-name>"
```

Replace `<your-agent-name>` with the name of your agent or application (for example `"Personal Assistant"`, `"Shopping Bot"`). The device-authorization page in the user's browser displays this name when they approve the connection. Use a clear, unique, identifiable name.

The response includes a `_next.command` — run it immediately to poll until authenticated. **Do not wait for the user to respond before starting the poll.** Example response:

```json
{
  "verification_url": "https://app.inflowpay.ai/device/?code=ABCD-EFGH",
  "phrase": "ABCD-EFGH",
  "_next": {
    "command": "auth status --interval 5 --max-attempts 60",
    "poll_interval_seconds": 5,
    "until": "authenticated is true"
  }
}
```

Present `verification_url` to the user. Start polling with the `_next.command` immediately — don't wait for them to reply.

If your environment can't relay the verification phrase to the user while a separate polling command blocks I/O, use inline polling instead:

```bash
inflow auth login --client-name "<name>" --interval 5 --timeout 300
```

**API key alternative:** if the user provides an API key, set `INFLOW_API_KEY=<key>` in the environment (or pass `--api-key <key>` to any command) instead of running `auth login`. The API key takes precedence over a saved device token.

### Step 2: Pre-flight evaluation

Three commands, in this order:

```bash
# 1. Probe the seller without paying
inflow x402 inspect <url>
# Returns the seller's accepts[]: { scheme, network, asset, max_amount_required, extra.name, ... }

# 2. List which scheme × network pairs the user's account supports
inflow x402 supported
# Returns: { "kinds": [{ "scheme": "exact", "network": "solana:mainnet" }, ...] }

# 3. Check balances for the candidate asset(s)
inflow balances list
# Returns: [{ "available": "100.5", "currency": "USDC" }, ...]
```

**Shortcut:** If the agent already received a 402 with a `PAYMENT-REQUIRED` header from a prior HTTP call (e.g., the browsing tool hit a paywall), skip step 1 and decode the header directly — no second probe needed:

```bash
inflow x402 decode '<PAYMENT-REQUIRED-header-value>'
# Returns the same accepts[] shape as `inspect`, parsed from the header you already have.
```

Now you have the three facts an agent needs: what the seller wants, what the account can pay with, and whether there's enough.

- If `inspect.accepts ∩ supported.kinds` is empty → stop with `NO_INFLOW_MATCH`. Tell the user the seller doesn't accept any scheme × network their account supports.
- If the intersection exists but `balances.available < max_amount_required` for every match → stop and tell the user to fund the account on a matching network. Run `inflow deposit-addresses list` and surface the deposit address(es) in full.
- Otherwise: proceed to Step 3.

**Optional filters** to narrow the match before `x402 pay`:

- `--scheme <s>` — e.g. `exact`, `balance`
- `--network <n>` — e.g. `solana:mainnet`, `eip155:84532`, `inflow:1`
- `--asset <a>` — on-chain asset identifier (ERC-20 contract address for EVM, mint pubkey for SVM)
- `--asset-name <name>` — human-readable symbol the seller advertises (e.g. `USDC`)

When any filter empties the accepts list, the command fails with `NO_FILTERED_MATCH` instead of falling through to the buyer's default prefer order.

**Decimal precision.** `balances.available` and `max_amount_required` are decimal strings preserving BigDecimal precision. **Never parse them to a JS `Number`** — that drops precision. Compare as strings, or use a `BigInt` / `decimal.js`-style library.

### Step 3: Pay via x402

Don't retry with the same `transaction_id` after `encoded_payload` is consumed — create a new transaction instead.

Before initiating the call, summarize the intent to the user in chat: amount, currency, resource URL, scheme, network. The user verifies the canonical details on the approval screen; the chat summary is what they read first. Example:

> "I'm about to pay 0.10 USDC on Solana mainnet to api.foo.dev for /article-3. Requesting approval next."

**Fast path (recommended).** When the agent can block until the payment finishes, set `--interval N` and let the CLI handle the full flow in one call — probe, decode, prepare, await approval, replay against the seller, return the body. One tool call, one result:

```bash
inflow x402 pay <url> --interval 5 --max-attempts 60
```

The result includes `outcome: "paid"`, `transaction_id`, `response_status`, `settled`, and the seller body inline (or `output_saved_to` if `--output-file` is set). To surface `approval_url` *before* the call returns (rather than at the end as part of the single result), add `--format jsonl` — frames stream line-by-line. With the default `json` (or `toon`), the agent only sees the final buffered result.

**Two-step path.** Use this when the agent's host can't block I/O long enough for the user to approve (chat UIs that need to yield between turns). Drop `--interval`; the first call returns `approval_url` + a `_next.command` for the status poll, and the agent drives the replay itself after `encoded_payload` arrives.

```bash
inflow x402 pay <url>
```

For non-GET requests, pass `--method`, `--data`, `--header` (repeatable):

```bash
inflow x402 pay https://seller.example.com/api/widgets \
  --method POST \
  --data '{"sku":"widget-1"}' \
  --header "X-Custom: value" \
  --interval 5 --max-attempts 60
```

**Retries and idempotency.** Set `--payment-id <id>` whenever a retry on transport failure is possible. The server treats two requests with the same `payment-id` as the same logical payment, so a retry after a network blip won't double-charge. Format: 16–128 chars, `^[a-zA-Z0-9_-]+$`.

**Discipline:** set `--payment-id` to a stable random opaque value generated once per intent. Reuse the same id on transport retry. Regenerate only when the user explicitly wants a fresh charge. Don't tie the id to wall-clock time — a date-based id silently double-charges on next-day "buy this again" requests.

```bash
inflow x402 pay <url> --payment-id "<stable-opaque-id>"
```

Without `--payment-id`, the server generates one each call — fine for one-shots, unsafe for retries.

**Sensitive / binary output.** `encoded_payload` (returned by `x402 status` after approval) is a one-time bearer credential — don't echo it back in chat. Use `--payload-file <path>` to write payload bytes to disk at mode `0o600`; the response then carries `payload_saved_to: <path>` in place of `encoded_payload`. For the seller's response body, `--output-file <path>` writes bytes to disk and replaces `body` / `body_base64` with `output_saved_to: <path>` — pair with `--no-show-body` for binary content (PDFs, images, audio, datasets) so bytes never appear inline as base64:

```bash
inflow x402 pay https://api.foo.dev/report.pdf --interval 5 --max-attempts 60 \
  --output-file /tmp/report.pdf --no-show-body
```

**Polling discipline.** Persist `transaction_id` as soon as `x402 pay` returns it. Then:

- Run `_next.command` (or `x402 status <transaction_id> --interval N`) immediately. Don't wait for the user to confirm before polling starts.
- If polling is interrupted — network drop, session bounce, user kills the agent — resume with `inflow x402 status <transaction_id> --interval 5 --max-attempts 60`. Only create a new transaction if the original expired (`APPROVAL_TIMEOUT`), was denied/cancelled, or its `encoded_payload` is already consumed.
- If `POLLING_TIMEOUT` fires before approval, ask the user whether to keep waiting or cancel — don't silently restart the poll.
- If >12 minutes elapsed without a user response, surface that explicitly so they can act before `APPROVAL_TIMEOUT` lands.
- If the user aborts ("nevermind", "cancel that"), call `inflow x402 cancel <approval_id>` before exiting. Otherwise the approval sits pending for 15 minutes and triggers phantom notifications in the user's InFlow app.

Once `x402 status` returns `encoded_payload`, replay the original seller request with `PAYMENT-SIGNATURE: <encoded_payload>` (or `PAYMENT-SIGNATURE: $(cat <payload-file>)` if you used `--payload-file`). The seller's protected response comes back on the replay.

## Worked example

End-to-end: a user asks the agent to fetch a paywalled article at `https://api.foo.dev/article-3`.

After running the Step 2 pre-flight commands, the intersection lands on `exact` × `solana:mainnet`, and the user's 100.5 USDC balance easily covers the 0.10 USDC the seller requires. Proceed.

> "I'm about to pay 0.10 USDC on Solana mainnet to api.foo.dev for /article-3.
> Your balance is 100.5 USDC — plenty. Requesting approval next."

```bash
inflow x402 pay https://api.foo.dev/article-3 \
  --payment-id "<stable-opaque-id>" --interval 5 --max-attempts 60
# Persist transaction_id from the response in case polling gets interrupted.
# -> { "outcome": "paid", "transaction_id": "txn_abc", "response_status": 200,
#      "body": "{ \"title\": \"How to brew coffee\", ... }", "settled": { ... } }
```

> "Approval requested — confirm in the InFlow app: https://app.inflowpay.ai/approvals/appr_xyz
> I'll keep polling. 15-min window."

Once the result arrives:

> "Paid 0.10 USDC. Transaction txn_abc. Server returned: 'How to brew coffee — ...'"

**Two-step variant** (host can't block long enough for approval): drop `--interval`, present `approval_url`, run the returned `_next.command`, then replay against the seller yourself — use `--payload-file <path>` on the status call and `PAYMENT-SIGNATURE: $(cat <path>)` on the replay.

## What to surface when something goes wrong

Match each terminal failure to a clear user-facing prompt — don't dump the raw error.

- **`APPROVAL_TIMEOUT`** — "You didn't approve within 15 minutes, so the request expired. Want me to start a new payment, or stop here?"
- **`APPROVAL_FAILED`** (declined / insufficient funds / generic) — "Approval didn't go through (declined or insufficient funds in the matched asset). Want me to try a different funding source, top up, or stop?"
- **`APPROVAL_CANCELLED`** — "You cancelled the approval. Stopping here unless you want to start a new payment."
- **`NO_INFLOW_MATCH`** — "The seller accepts `<scheme>` on `<network>`, but your account is funded on `<other-network>`. Either fund your account on `<network>`, or pick a different seller."
- **`NO_FILTERED_MATCH`** — "Your filter (`--scheme/--network/--asset`) removed every option the seller accepts. Loosen the filter or check the seller's `accepts` list with `inflow x402 inspect`."
- **`POLLING_TIMEOUT`** — "Still waiting on your approval — want me to keep polling, or cancel the request? (`inflow x402 cancel <approval_id>` cancels it.)"
- **`VERSION_UNSUPPORTED` / HTTP 426** — "The installed `inflow` CLI is below the minimum supported version. Run `npm install -g @inflowpayai/inflow@latest` and re-try."

## Limits

| Limit                          | Value                                                                                               |
| ------------------------------ | --------------------------------------------------------------------------------------------------- |
| Approval window                | 15 minutes from `x402 pay` creating the transaction (`--timeout` overrides the polling deadline)    |
| Default polling max-attempts   | Unlimited (`--max-attempts 0`). Set a positive cap when you need a hard stop                        |
| `--payment-id` format          | 16–128 chars, `^[a-zA-Z0-9_-]+$`                                                                    |
| `encoded_payload` reuse        | One-time. Consumed by the first seller replay. Not reusable — failed seller calls require a new pay |

## Important

- Treat OAuth tokens and API keys as secrets — never echo them. The `encoded_payload` returned by `x402 status` is a one-time bearer credential; replay it directly against the seller and discard, don't paste it back to the user.
- Respect `/agents.txt` and `/llm.txt` on sites you browse.
- Avoid suspicious 402 endpoints — if the domain doesn't match what the user asked to pay, or the price is wildly different from expectation, stop and ask.
- When displaying deposit addresses to the user, print the full address (don't truncate). Truncating breaks copy-paste.

## Out of scope

This skill covers programmatic HTTP 402 (x402) payments only. It does NOT handle:

- **Traditional merchant checkouts** (card forms, Stripe Elements, hosted checkouts). No PANs.
- **Card issuance** or wallet management beyond `balances list` and `deposit-addresses list`.
- **Refunds, disputes, chargebacks** — handled out of band via support.
- **Peer-to-peer transfers** between users or wallets.
- **FX / currency conversion.** Buyer logic matches the seller's `accepts[]` against the account's supported assets; if no overlap, fund or use a different source.
- **Subscriptions / recurring payments.** Each `x402 pay` is one-shot. Schedule externally.

For any of the above, point the user to https://app.inflowpay.ai or support.

## Errors

All errors in agent mode are JSON with `code` and `message` fields and exit code 1.

| Error code                                                    | Meaning                                                                                                                                                                                                              | Recovery                                                                                                                                                                                                                               |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APPROVAL_CANCELLED` / `APPROVAL_FAILED` / `APPROVAL_TIMEOUT` | Approval did not produce an `encoded_payload` — cancelled via `x402 cancel` or server-side / declined or insufficient funds or generic error / 15-minute window elapsed. | Call `inflow x402 status <transaction_id>` for the precise reason; create a new transaction. User-facing prompts for each variant are in "What to surface."                                                                                                                        |
| `INVALID_402` / `DECODE_FAILED`                               | Seller returned 402 but the `PAYMENT-REQUIRED` header was missing (`INVALID_402`) or unparseable (`DECODE_FAILED`).                                                                                                  | Verify the URL is x402-protected. Pass the raw header to `inflow x402 decode` for the detailed parse error.                                                                                                                            |
| `INVALID_PAYMENT_ID`                                          | `--payment-id` doesn't match `^[a-zA-Z0-9_-]+$` and 16–128 chars.                                                                                                                                                    | Adjust or omit the payment id.                                                                                                                                                                                                         |
| `NO_FILTERED_MATCH`                                           | A `--scheme` / `--network` / `--asset` / `--asset-name` filter emptied the candidate `accepts[]` list.                                                                                                                | Loosen the filter or call `inflow x402 inspect <url>` to see what the seller actually accepts.                                                                                                                                        |
| `NO_INFLOW_MATCH`                                             | Seller doesn't accept any scheme × network the user's InFlow account supports.                                                                                                                                       | Use a different buyer or fund the user's account on a chain the seller accepts.                                                                                                                                                        |
| `NOT_AUTHENTICATED`                                           | No saved device token and no `--api-key` / `INFLOW_API_KEY` configured.                                                                                                                                              | Run `inflow auth login` or set the API key env var.                                                                                                                                                                                    |
| `POLLING_TIMEOUT`                                             | `--interval` polling reached its max-attempts or timeout. Retryable.                                                                                                                                                 | Resume with `inflow x402 status <transaction_id> --interval 5 --max-attempts 60`.                                                                                                                                                      |
| `api_error`                                                   | Non-2xx from the InFlow API. Discriminate on `httpStatus`.                                                                                                                                                            | `401` — saved auth rejected; run `inflow auth login` again. `426` (`VERSION_UNSUPPORTED`) — upgrade with `npm install -g @inflowpayai/inflow@latest` and re-try; don't retry on the old version. `5xx` — server-side; wait and retry. |
| `transport_error`                                             | Network failure.                                                                                                                                                                                                     | Check connectivity; retry.                                                                                                                                                                                                             |

## Further docs

- MPP protocol: https://mpp.dev
- x402 protocol: https://x402.io
- InFlow: https://app.inflowpay.ai
