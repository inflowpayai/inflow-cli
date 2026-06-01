---
version: 0.5.2
name: agentic-payments
description: Authenticate with InFlow and pay HTTP 402-protected resources via MPP (the `Payment` auth scheme) or x402. Use when the user invokes the `inflow` CLI or asks to log in / connect to InFlow.
allowed-tools: ['Bash(inflow:*)', 'Bash(npx:*)', 'Bash(npm:*)']
user-invocable: true
license: MIT
metadata: { "author": "Jarwin, Inc.", "url": "app.inflowpay.ai", "openclaw": { "emoji": "💸", "homepage": "https://app.inflowpay.ai", "requires": { "bins": ["inflow"] }, "install": [{ "id": "npm", "kind": "node", "package": "@inflowpayai/inflow", "bins": ["inflow"], "label": "Install InFlow" }] } }
---

# Agentic Payments

Pay HTTP 402-protected resources on the user's behalf. InFlow speaks two payment protocols — **MPP** and **x402** — but the flow is the same for both: shared setup (install, run, authenticate), then a **router** that picks the protocol from the seller's 402 header, then one **Paying a 402 resource** section that covers both. A per-protocol **delta table** at the top of that section lists the handful of real differences (header name, credential name, filters, error codes); read your row, then follow the shared steps.

## Installing

Install with `npm install -g @inflowpayai/inflow`. Or run directly with `npx @inflowpayai/inflow`.

## Running

InFlow runs as a **standalone CLI** or an **MCP server**.

**MCP**: add an `inflow` server to your MCP client config that runs `npx -y @inflowpayai/inflow --mcp`. Keep the `-y` flag — it suppresses npx's confirmation prompt, without which the MCP host can stall on first run.

**MCP mode** exposes every CLI command as a tool. Call `tools/list` on the MCP server for the authoritative inventory; arguments mirror the CLI flags one-to-one.

### Common commands / options

**The CLI is the source of truth for exact flags, enums, and output shapes** — run `inflow <command> --schema` for one command, or `inflow --llms-full` for everything. This playbook covers *when and why*, not exhaustive parameter lists; when you need a precise flag name, value set, or response shape, query the CLI rather than guessing.

- `inflow --llms` (or `--llms-full` for parameter detail) — discover all commands. `inflow <command> --schema` for a single command's JSON Schema.
- `inflow --skill` — print this playbook (no frontmatter) to stdout. Use it to paste into the system-prompt field of an MCP host that doesn't natively load skills: `inflow --skill | pbcopy`.
- Default output is `toon`. Override with `--format <fmt>`; for programmatic parsing prefer `json` (single document) or `jsonl` (line-delimited).
- Multi-step flows return `_next.command` — run it to continue.
- `--auth <path>` overrides the credentials file location.
- `--api-key <key>` or `INFLOW_API_KEY=<key>` is an alternative to device-flow auth.

## Authenticate

Authentication is shared by both protocols — do it once, before either payment flow. **Don't start a payment until the user is authenticated.**

Check the current state first — the user may already be logged in:

```bash
inflow auth status
```

A successful `auth status` returns `authenticated: true` plus `auth_method` (`device_token` or `api_key`), a truncated `access_token` preview (never the full token), `credentials_path`, `connection`, and possibly an `update` field. For the user's identity (email, handle, account id), call `inflow user get` — `auth status` deliberately omits it. Run the command to see the full shape.

If the response includes an `update` field, a newer version of `inflow` is published.

**Surface and defer.** Tell the user a newer version is available and how to upgrade — `npm install -g @inflowpayai/inflow@latest` (or `npx @inflowpayai/inflow@latest`). Then **proceed with the current version**. Only block on the upgrade if a subsequent command fails with `VERSION_UNSUPPORTED` (or an HTTP 426 from the API), at which point the upgrade is mandatory and you should not retry until it lands.

If `authenticated` is `false`, start the device flow:

```bash
inflow auth login --client-name "<your-agent-name>"
```

Replace `<your-agent-name>` with the name of your agent or application (for example `"Personal Assistant"`, `"Shopping Bot"`). The device-authorization page in the user's browser displays this name when they approve the connection. Use a clear, unique, identifiable name.

The response includes a `verification_url` (present this to the user), a `phrase`, and a `_next.command`. Run that command immediately to poll until authenticated. **Do not wait for the user to respond before starting the poll.**

If your environment can't relay the verification phrase to the user while a separate polling command blocks I/O, use inline polling instead:

```bash
inflow auth login --client-name "<name>" --interval 5 --timeout 300
```

**API key alternative:** if the user provides an API key, set `INFLOW_API_KEY=<key>` in the environment (or pass `--api-key <key>` to any command) instead of running `auth login`. The API key takes precedence over a saved device token.

## Which protocol? — start here

Before paying, decide which protocol the resource uses. **You do not choose it — the seller's 402 challenge header decides.** Detection is read-only and needs no auth.

1. Get the 402 challenge header. If a prior HTTP call already returned a 402 (e.g. the browsing tool hit a paywall), use that response. Otherwise make a plain, **unauthenticated GET** to the URL and read the headers of the 402.
2. Branch on the header — **check for MPP first:**

| 402 carries… | Protocol | Then |
| --- | --- | --- |
| `WWW-Authenticate: Payment` | **MPP** | Go to [§ Paying a 402 resource](#paying-a-402-resource); use the **MPP** column of the delta table |
| `WWW-Authenticate: Payment` **and** `PAYMENT-REQUIRED` | **MPP** (MPP wins when both are present) | Go to [§ Paying a 402 resource](#paying-a-402-resource); use the **MPP** column |
| `PAYMENT-REQUIRED` only | **x402** | Go to [§ Paying a 402 resource](#paying-a-402-resource); use the **x402** column |
| neither header, or the response isn't a 402 | not InFlow-payable | Stop. Tell the user the resource isn't a supported 402 endpoint. |

Note: the `inspect` and `decode` commands are protocol-specific (`inflow mpp …` vs `inflow x402 …`), which is why you detect the header *first*, then use that protocol's tools.

---

## Paying a 402 resource

One flow for both protocols. Prerequisite: you are authenticated (see [Authenticate](#authenticate)). First find your protocol's row in the **Protocol deltas** table below — it names the 402 header that selected it, the matching model, the filter flags, and the credential and replay header you'll use. Everything else in this section applies to both protocols.

**Sequencing.** Run pre-flight before pay — `pay` fails or double-charges if the pre-flight checks didn't clear. `inspect` and `decode` are read-only and need no auth, so they may run before you authenticate if useful (e.g. sizing up a paywall first).

### Protocol deltas

| Aspect | MPP | x402 |
| --- | --- | --- |
| Selected when the 402 carries | `WWW-Authenticate: Payment` | `PAYMENT-REQUIRED` (and no `WWW-Authenticate: Payment`) |
| Command prefix | `inflow mpp …` | `inflow x402 …` |
| Matching model | The seller's challenge **pins the rail** — the buyer does not choose scheme/network/asset | Pay where `inspect.accepts ∩ supported.kinds` is non-empty |
| Filter flags | `--payment-method`, `--intent`, `--currency`, `--rail`, `--instrument-id` | `--scheme`, `--network`, `--asset`, `--asset-name` |
| Credential field (after approval) | `credential` (from `mpp status` when `state` is `ready`) | `encoded_payload` (from `x402 status` after approval) |
| Replay header | `Authorization: Payment <credential>` | `PAYMENT-SIGNATURE: <encoded_payload>` |
| Write-credential-to-disk flag | `--credential-file <path>` | `--payload-file <path>` |
| Idempotency | — | `--payment-id` (see Step 2) |
| Cancel uses | `approval_id` | `approval_id` |
| Protocol-specific error codes | `PAYMENT_FAILED`, `PAYMENT_EXPIRED`, `PAYMENT_NOT_ACCEPTED` | `APPROVAL_TIMEOUT`, `APPROVAL_FAILED`, `APPROVAL_CANCELLED` |

Throughout this section `<mpp|x402>` means "use your protocol's prefix." For the exact parameters and output shape of any command below, run `inflow <command> --schema`.

### Step 1: Pre-flight evaluation

```bash
# 1. Parse what the seller will accept — read-only, no auth
inflow <mpp|x402> inspect <url>

# (Already have the 402 header from a prior response? Decode it directly instead of re-probing:)
inflow <mpp|x402> decode '<402 header value>'

# 2. List what the buyer's account can pay with
inflow <mpp|x402> supported

# 3. Check balances for the candidate currency/asset(s)
inflow balances list
```

`inspect` / `decode` return what the seller accepts — the price is the `amount` field (for x402 the human-readable symbol is `extra.assetName`); `decode` also accepts a base64url credential / receipt. `supported` returns what the account can pay with; `balances list` returns `available` per currency. Run the commands to see the exact shapes.

Decide whether you can pay (apply your protocol's matching model from the delta table):

| Condition | Meaning | Action |
| --- | --- | --- |
| No payable match between the seller and the buyer's `supported` methods | No payable rail | Stop → `NO_INFLOW_MATCH`. Tell the user the seller's rails aren't supported by their account. |
| A match exists, but `balances.available < amount` for every match | Right rail, not enough funds | Stop → run `inflow deposit-addresses list`, surface the address(es) in full, ask the user to fund a matching network. |
| A match exists **and** ≥1 match has `balances.available ≥ amount` | Payable | Proceed to Step 2. |

**Optional filters** narrow *which* offer to fulfil — optional, AND-combined, applied on both `pay` and `inspect`, and an empty result fails with `NO_FILTERED_MATCH` (it does not fall through to a default order). One non-obvious case: MPP's `--instrument-id` picks *how* to fund (an instrument-rail / fiat challenge), not which challenge. For the exact filter flags and accepted values per protocol, run `inflow <mpp|x402> pay --schema`.

**Decimal precision.** `balances.available` and the challenge/`amount` value are decimal strings preserving BigDecimal precision. **Never parse them to a JS `Number`** — that drops precision. Compare as strings, or use a `BigInt` / `decimal.js`-style library.

### Step 2: Pay

Before initiating the call, summarize the intent to the user in chat: amount, currency, resource URL, and the method/rail (MPP) or scheme/network (x402). The user verifies the canonical details on the approval screen; the chat summary is what they read first. Example:

> "I'm about to pay 0.10 USDC to api.foo.dev for /dataset.csv. Requesting approval next."

**Fast path (recommended).** When the agent can block until the payment finishes, set `--interval N` and let the CLI run the whole flow in one call — probe, decode, prepare, await approval, replay against the seller, return the body:

```bash
inflow <mpp|x402> pay <url> --interval 5 --max-attempts 180
```

The result includes `outcome`, `transaction_id`, `response_status`, `settled`, the seller body inline (or `output_saved_to` if `--output-file` is set), and the now-consumed credential (`credential` for MPP, `encoded_payload` for x402). On the fast path the CLI has already replayed that credential to fetch the body — it appears in the result for reference only; **do not replay it yourself.** To surface `approval_url` *before* the call returns, add `--format jsonl` — frames stream line-by-line. With the default `json` (or `toon`), the agent only sees the final buffered result.

**`outcome` values.** A completed `pay` returns one of three terminal outcomes — branch on it, don't assume `paid`:

| `outcome` | Meaning | What to do |
| --- | --- | --- |
| `paid` | Settled and the seller returned 2xx | Deliver the body to the user |
| `no-payment-required` | The resource wasn't paywalled, or was already paid | Tell the user nothing was charged; return the body |
| `replay-rejected` | Payment was approved (funds in transit) but the seller replied non-2xx on the replay | Do NOT report success. Tell the user the seller's response failed; because the payment didn't complete, the in-transit funds are reverted to their InFlow balance. Offer to retry |

**Two-step path.** Use this when the agent's host can't block I/O long enough for the user to approve (chat UIs that yield between turns). Drop `--interval`; the first call returns `transaction_id` + `approval_id` + `approval_url` + a `_next` `status` command, and the agent drives the replay itself once a credential arrives.

```bash
inflow <mpp|x402> pay <url>
# -> { "transaction_id": "txn_abc", "approval_id": "appr_xyz", "approval_url": "https://app.inflowpay.ai/approvals/appr_xyz", "_next": { "command": "<mpp|x402> status txn_abc --interval 5 --max-attempts 180" } }
```

Mind the two distinct ids: poll, replay, and resume all use `transaction_id`; **cancel uses `approval_id`** (`inflow <mpp|x402> cancel <approval_id>`). Both are returned by `pay`.

For non-GET requests, pass `--method`, `--data`, `--header` (repeatable):

```bash
inflow <mpp|x402> pay https://seller.example.com/api/widgets --method POST --data '{"sku":"widget-1"}' --header "X-Custom: value" --interval 5 --max-attempts 180
```

**Idempotency (x402 only).** Set `--payment-id <id>` whenever a retry on transport failure is possible — the server treats two requests with the same id as the same logical payment, so a retry after a network blip won't double-charge. Use a stable random opaque value generated once per intent; reuse the same id on transport retry; regenerate only when the user explicitly wants a fresh charge. Don't tie the id to wall-clock time — a date-based id silently double-charges on next-day "buy this again" requests. Without `--payment-id`, the server generates one each call — fine for one-shots, unsafe for retries. (Format constraints: `inflow x402 pay --schema`.)

```bash
inflow x402 pay <url> --payment-id "<stable-opaque-id>"
```

**Sensitive / binary output.** The one-time bearer credential (`credential` for MPP, `encoded_payload` for x402; returned after approval and echoed in the fast-path result) must not be echoed back in chat. Write it to disk at mode `0o600` with your protocol's flag (`--credential-file <path>` for MPP, `--payload-file <path>` for x402); replay then reads from that file. For the seller's response body, `--output-file <path>` writes bytes to disk and replaces `body` / `body_base64` with `output_saved_to: <path>` — pair with `--no-show-body` for binary content (PDFs, images, audio, datasets) so bytes never appear inline as base64:

```bash
inflow <mpp|x402> pay https://api.foo.dev/dataset.csv --interval 5 --max-attempts 180 --output-file /tmp/dataset.csv --no-show-body
```

**Polling discipline.** Persist `transaction_id` as soon as `pay` returns it. Then:

- Run `_next.command` (or `<mpp|x402> status <transaction_id> --interval N`) immediately. Don't wait for the user to confirm before polling starts.
- If polling is interrupted — network drop, session bounce, user kills the agent — resume with `inflow <mpp|x402> status <transaction_id> --interval 5 --max-attempts 180`. Only create a new transaction if the original expired (`PAYMENT_EXPIRED` for MPP, `APPROVAL_TIMEOUT` for x402), was denied/cancelled, or its credential is already consumed.
- If `POLLING_TIMEOUT` fires before approval, ask the user whether to keep waiting or cancel — don't silently restart the poll.
- If >12 minutes elapsed without a user response (≈3 min before the 15-minute approval window closes), surface that explicitly so they can act before the window closes.
- If the user aborts ("nevermind", "cancel that"), call `inflow <mpp|x402> cancel <approval_id>` before exiting. Otherwise the approval sits pending for 15 minutes and triggers phantom notifications in the user's InFlow app.

Once `status` reports the credential (MPP: `state: ready` with `credential`; x402: `encoded_payload`), replay the original seller request with your protocol's replay header from the delta table — `Authorization: Payment <credential>` (MPP) or `PAYMENT-SIGNATURE: <encoded_payload>` (x402); use `$(cat <file>)` if you wrote it to disk with `--credential-file` / `--payload-file`. The seller's protected response comes back on the replay.

### Limits

| Limit | Value |
| --- | --- |
| Approval window | 15 minutes from `pay` creating the transaction (`--timeout` overrides the polling deadline) |
| Polling stop condition | Polling ends at whichever fires first: `--max-attempts` (count, default `0` = unlimited) or `--timeout` (seconds, default `900` = the full 15-min window). The examples use `--interval 5 --max-attempts 180` (= 900 s) so a copied command covers the whole window — `--interval 5 --max-attempts 60` (= 300 s) would stop polling at 5 min, well before approval can land |
| Credential reuse | One-time. The credential (`credential` for MPP, `encoded_payload` for x402) is consumed by the first seller replay — not reusable; a failed seller call requires a new `pay` |

### Worked example (MPP)

A user asks the agent to fetch a paywalled dataset at `https://api.foo.dev/dataset.csv` that answered 402 with `WWW-Authenticate: Payment`.

Pre-flight: `inflow mpp inspect <url>` (the seller's challenges), `inflow mpp supported` (methods the buyer can pay with), `inflow balances list`. The seller offers the `inflow` method in USDC; the user's 100.5 USDC balance covers the 0.10 USDC price. Summarize intent, then pay:

```bash
inflow mpp pay https://api.foo.dev/dataset.csv --interval 5 --max-attempts 180 --output-file /tmp/dataset.csv --no-show-body
# Persist transaction_id from the response in case polling is interrupted.
# Returns outcome "paid" with output_saved_to /tmp/dataset.csv.
```

> "Approval requested — confirm in the InFlow app: https://app.inflowpay.ai/approvals/appr_xyz
> I'll keep polling. 15-min window."

Once the result arrives:

> "Paid 0.10 USDC. Transaction txn_abc. Saved the dataset to /tmp/dataset.csv."

**Two-step variant** (host can't block): follow Step 2's two-step path; once `mpp status` reports `state: ready`, replay with `Authorization: Payment <credential>` (or `$(cat <path>)` via `--credential-file` to keep it out of chat).

### Worked example (x402)

A user asks the agent to fetch a paywalled article at `https://api.foo.dev/article-3` that answered 402 with `PAYMENT-REQUIRED`.

Pre-flight: the intersection lands on `exact` × `solana:mainnet`, and the user's 100.5 USDC balance easily covers the 0.10 USDC the seller requires. Proceed.

> "I'm about to pay 0.10 USDC on Solana mainnet to api.foo.dev for /article-3.
> Your balance is 100.5 USDC — plenty. Requesting approval next."

```bash
inflow x402 pay https://api.foo.dev/article-3 --payment-id "<stable-opaque-id>" --interval 5 --max-attempts 180
# Persist transaction_id from the response in case polling gets interrupted.
# Returns outcome "paid"; body contains the article JSON.
```

> "Approval requested — confirm in the InFlow app: https://app.inflowpay.ai/approvals/appr_xyz
> I'll keep polling. 15-min window."

Once the result arrives:

> "Paid 0.10 USDC. Transaction txn_abc. Server returned: 'How to brew coffee — ...'"

**Two-step variant** (host can't block): follow Step 2's two-step path; once `x402 status` returns the `encoded_payload`, replay with `PAYMENT-SIGNATURE: <encoded_payload>` (use `--payload-file` to keep it out of chat).

### MPP errors

All errors in agent mode are JSON with `code` and `message` fields and exit code 1. MPP-specific codes (shared codes are in [§ Shared errors](#shared-errors)). "What to tell the user" is the prompt to surface — don't dump the raw error:

| Error code | Recovery | What to tell the user |
| --- | --- | --- |
| `PAYMENT_FAILED` | `inflow mpp status <transaction_id>` for the precise state, then create a new transaction with `inflow mpp pay`. (Terminal `failed` state, or no credential produced.) | "The payment didn't go through — it was declined, underfunded, or the transaction failed. Want me to try again, switch funding, or stop?" |
| `PAYMENT_EXPIRED` | Start a new `inflow mpp pay`. | "The payment window expired before it was ready to settle. Want me to start a new one, or stop here?" |
| `PAYMENT_NOT_ACCEPTED` | `inflow mpp inspect <url>` to re-check the challenge; adjust and retry. | — |

### x402 errors

All errors in agent mode are JSON with `code` and `message` fields and exit code 1. x402-specific codes (shared codes are in [§ Shared errors](#shared-errors)). "What to tell the user" is the prompt to surface — don't dump the raw error:

| Error code | Recovery | What to tell the user |
| --- | --- | --- |
| `APPROVAL_TIMEOUT` | `inflow x402 status <transaction_id>` for the precise reason, then create a new transaction. | "You didn't approve within 15 minutes, so the request expired. Want me to start a new payment, or stop here?" |
| `APPROVAL_FAILED` | Same recovery as `APPROVAL_TIMEOUT` (declined / insufficient funds in the matched asset / generic). | "Approval didn't go through (declined or insufficient funds in the matched asset). Want me to try a different funding source, top up, or stop?" |
| `APPROVAL_CANCELLED` | Same recovery (cancelled via `x402 cancel` or server-side). | "You cancelled the approval. Stopping here unless you want to start a new payment." |
| `INVALID_PAYMENT_ID` | `--payment-id` violated the format (see `inflow x402 pay --schema`). Adjust or omit the payment id. | — |

---

## Security & data handling

Applies to both protocols.

- Treat OAuth tokens and API keys as secrets — never echo them. The one-time bearer credential (`encoded_payload` for x402, `credential` for MPP) returned after approval should be replayed directly against the seller and discarded, not pasted back to the user.
- Respect `/agents.txt` and `/llm.txt` on sites you browse.
- Avoid suspicious 402 endpoints — if the domain doesn't match what the user asked to pay, or the price is different from expectation, stop and ask.
- When displaying deposit addresses to the user, print the full address (don't truncate). Truncating breaks copy-paste.

## Shared errors

These apply to both protocols (in addition to each section's protocol-specific codes). All are JSON with `code` and `message` and exit code 1. Where a command is protocol-specific, use your prefix (`<mpp|x402>`). "What to tell the user" is the prompt to surface — don't dump the raw error:

| Error code | Recovery | What to tell the user |
| --- | --- | --- |
| `NOT_AUTHENTICATED` | No saved device token and no `--api-key` / `INFLOW_API_KEY` configured. Run `inflow auth login` or set the API key env var. | — |
| `NO_INFLOW_MATCH` | Seller's rails aren't supported by the account. Fund a matching method/chain, or use a different seller. | "The seller wants `<method/rail or scheme×network>`, but your account can't pay on that rail. Either fund a matching method, or pick a different seller." |
| `NO_FILTERED_MATCH` | A filter emptied the candidate list. Loosen it, or re-check with `inflow <mpp|x402> inspect <url>` (filter flags per the delta table). | "Your filter removed every option the seller accepts. Loosen it or check the seller's options with `inflow <mpp|x402> inspect`." |
| `INVALID_402` / `DECODE_FAILED` | Seller returned 402 but the protocol's header was missing (`INVALID_402`) or unparseable (`DECODE_FAILED`). Verify the URL is payable; pass the raw header to `inflow <mpp|x402> decode` for the detailed parse error. | — |
| `POLLING_TIMEOUT` | `--interval` polling reached its max-attempts or timeout. Retryable — resume with `inflow <mpp|x402> status <transaction_id> --interval 5 --max-attempts 180`. | "Still waiting on your approval — want me to keep polling, or cancel the request? (`inflow <mpp|x402> cancel <approval_id>` cancels it.)" |
| `api_error` | Non-2xx from the InFlow API on the plain data calls (`user`, `balances`, `deposit-addresses`); discriminate on `httpStatus`. `401` — saved auth rejected, re-run `inflow auth login`. `426` (`VERSION_UNSUPPORTED`) — upgrade and retry. `5xx` — server-side; wait and retry. (Note: `pay`/`status` rejections instead surface the server's own code, e.g. `INSUFFICIENT_FUNDS`, or the protocol's terminal code — not `api_error`.) | — |
| `VERSION_UNSUPPORTED` / HTTP 426 | Installed `inflow` CLI is below the minimum supported version. `npm install -g @inflowpayai/inflow@latest`, then retry; don't retry on the old version. | — |
| `transport_error` | Network failure — check connectivity; retry. | — |

## Out of scope

This skill covers programmatic HTTP 402 payments (MPP and x402) only. It does NOT handle:

- **Traditional merchant checkouts** No PANs (credit card forms, hosted checkouts).
- **Card issuance** or wallet management beyond `balances list` and `deposit-addresses list`.
- **Refunds, disputes, chargebacks** — handled out of band via support.
- **Peer-to-peer transfers** between users or wallets.
- **FX / currency conversion.** Buyer logic matches the seller's accepted rails against the account's supported assets.
- **Subscriptions / recurring payments.** Each `pay` is one-shot.

For any of the above, point the user to https://app.inflowpay.ai or support.

## Further docs

- MPP protocol: https://mpp.dev
- x402 protocol: https://x402.org
- InFlow: https://app.inflowpay.ai
