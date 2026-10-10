---
version: 0.14.1
name: agentic-payments
description: Authenticate with InFlow and pay HTTP 402-protected resources via MPP (the `Payment` auth scheme) or x402. Use when the user invokes the `inflow` CLI or asks to log in / connect to InFlow.
allowed-tools: ['Bash(inflow:*)', 'Bash(brew:*)', 'Bash(curl:*)']
user-invocable: true
license: MIT
metadata: { "author": "Jarwin, Inc.", "url": "inflowcli.ai", "openclaw": { "emoji": "💸", "homepage": "https://inflowcli.ai", "requires": { "bins": ["inflow"] }, "install": [{ "id": "homebrew-cask", "kind": "homebrew", "tap": "inflowpayai/tap", "cask": "inflow", "bins": ["inflow"], "label": "Install InFlow with Homebrew" }, { "id": "hosted-shell", "kind": "shell", "url": "https://inflowcli.ai/install.sh", "bins": ["inflow"], "label": "Install InFlow with the hosted installer" }] } }
---

# Agentic Payments

Pay HTTP 402-protected resources on the user's behalf. InFlow speaks two payment protocols - **MPP** and **x402** - but the flow is the same for both: shared setup (install, run, authenticate), then a **router** that picks the protocol from the seller's 402 header, then one **Paying a 402 resource** section that covers both. A per-protocol **delta table** at the top of that section lists the handful of real differences (header name, credential name, filters, error codes); read your row, then follow the shared steps.

## Installing

Install the signed native CLI through one of these channels:

| Channel | Command |
| --- | --- |
| macOS Homebrew | `brew tap inflowpayai/tap && brew install --cask inflow` |
| macOS/Linux hosted installer | `curl -fsSL https://inflowcli.ai/install.sh \| bash` |
| Windows PowerShell installer | `irm https://inflowcli.ai/install.ps1 \| iex` |
| Cross-platform shell compatibility | `curl -fsSL https://inflowcli.ai/cli \| bash` |

Current install instructions live at https://inflowcli.ai/.

## Running

InFlow runs as a **standalone CLI** or an **MCP server**.

**MCP**: add an `inflow` server to your MCP client config that runs `inflow --mcp`.

**MCP mode** exposes every CLI command as a tool. Call `tools/list` on the MCP server for the authoritative inventory; arguments mirror the CLI flags one-to-one.

### Common commands / options

**The CLI is the source of truth for exact flags, enums, and output shapes** - run `inflow <command> --schema` for one command, or `inflow --llms-full` for everything. This playbook covers *when and why*, not exhaustive parameter lists; when you need a precise flag name, value set, or response shape, query the CLI rather than guessing.

- `inflow --llms` (or `--llms-full` for parameter detail) - discover all commands. `inflow <command> --schema` for a single command's JSON Schema.
- `inflow --skill` - print this playbook (no frontmatter) to stdout. Use it to paste into the system-prompt field of an MCP host that doesn't natively load skills: `inflow --skill | pbcopy`.
- Default output is `toon`. Override with `--format <fmt>`; for programmatic parsing prefer `json` (single document) or `jsonl` (line-delimited).
- Deferred payments return `_next.tool` and `_next.input` for the InFlow MCP server. For shell use, prefix `_next.command` with `inflow` when supplied. If `requires_original_request_options` is true, restore the original `data` and `header` arguments before calling Fetch; they are deliberately omitted from the response.
- `--auth <path>` identifies a legacy plaintext credential file for deletion; it is not a credential backend.
- `--api-key <key>` or `INFLOW_API_KEY=<key>` is an alternative to device-flow auth.

## Authenticate

Authentication is shared by both protocols - do it once, before either payment flow. **Don't start a payment until the user is authenticated.**

Credential-bearing commands require the encrypted local vault. If the CLI reports that the vault is uninitialized or
locked, tell the user to run `inflow vault unlock` themselves in a terminal, then retry. Never ask for or accept the
vault PIN or passphrase through chat, an MCP tool, a command-line flag, or an environment variable.

Check the current state first - the user may already be logged in:

```bash
inflow auth status
```

A successful `auth status` returns `authenticated: true` plus `auth_method` (`device_token` or `api_key`), a truncated `access_token` preview (never the full token), `credentials_path`, `connection`, and possibly an `update` field. Run the command to see the full shape.

If the response includes an `update` field, a newer version of `inflow` is published.

**Surface and defer.** Tell the user a newer version is available and share the install instructions at https://inflowcli.ai/. Then **proceed with the current version**. Only block on the upgrade if a subsequent command fails with `VERSION_UNSUPPORTED` (or an HTTP 426 from the API), at which point the upgrade is mandatory and you should not retry until it lands.

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

If `auth status` returns `VAULT_LOCKED`, authentication status is unavailable rather than unauthenticated. Tell the user
to run `inflow vault unlock` themselves in a terminal, then retry `auth status`.

## Which protocol? - start here

Before paying, decide which protocol the resource uses. **You do not choose it - the seller's 402 challenge decides.**
An OpenAPI `prepare` or `call` result may provide a `next` array with payment commands, a URL, request options and
`requiredInputs`. Follow the protocol selection table below, including MPP precedence when both are present;
discovery metadata alone does not prove the account can pay its offers. Preserve the method, headers and body, and
supply original values for redacted credentials. A pay command requests a fresh challenge; it does not resume the
earlier response. A `payment-required` result is not payment authorization.

Start by inspecting the URL:

```bash
inflow inspect <url>
```

An endpoint may require `--method`, repeatable `--header` values, and `--data` to supply its request body. Use the
endpoint's documented request requirements, or preserve those inputs from an OpenAPI preparation or handoff.
Explicit request options select endpoint probing. Without them, origins and recognized ODP/OpenAPI document URLs select document
discovery and return `document-inspected`, not payment terms. Other paths are endpoint probes. A probe sends an actual
request and may perform the operation if the endpoint allows it; it is not inherently read-only. Document discovery
and `decode` do not invoke the operation.

Endpoint inspection decodes both MPP and x402 from the response. Read `detected`, then match the offers against what
the account supports. For MPP, use `mpp subscribe` for `subscription` and `mpp pay` for a supported one-time charge.
Do not treat a different advertised intent or payment method as supported merely because it uses MPP.

If `detected` includes `aep` and also reveals a payment protocol, continue with the matching `mpp pay` or `x402 pay`;
the payment commands perform AEP authentication before creating the payment transaction. If `aep.blocked` is true, AEP
authentication is required before payment terms can be inspected; use `inflow aep fetch <url>` for access-only requests
or ask whether to authenticate before attempting payment.

| `detected` | Pay with |
| --- | --- |
| `["mpp"]` | `inflow mpp subscribe <url>` for a subscription challenge; otherwise `inflow mpp pay <url>` |
| `["x402"]` | `inflow x402 pay <url>` |
| `["mpp", "x402"]` | Use the matching MPP command - **MPP wins when both are present** |
| `[]` (seller still returned 402) | Not InFlow-payable on this account. Stop and tell the user; check `warnings` for why. |

If `inspect` returns `outcome: "no-payment-required"`, the URL isn't paywalled - there's nothing to pay.

---

## Paying a 402 resource

This section covers one-time MPP charges and x402 payments. MPP subscriptions use [Subscribing to an MPP resource](#subscribing-to-an-mpp-resource). Prerequisite: you are authenticated (see [Authenticate](#authenticate)). First find your protocol's row in the **Protocol deltas** table below - it names the 402 header that selected it, the matching model, the filter flags, and the Fetch command that completes the seller request. Everything else in this section applies to both protocols.

**Sequencing.** Complete pre-flight before paying: review the target, price, supported payment method and available
funds. Reuse information already obtained from inspection or OpenAPI preparation; a separate `inspect` call is not
mandatory when that information is available. Both payment commands obtain a fresh challenge themselves. Endpoint
probing sends a request and can execute an operation; it is not inherently read-only. If the seller requires AEP before
payment, `pay` authenticates with the Service first, then creates the payment only after the legitimate 402 is available.
Do not run a separate `aep grant` just to continue payment.

### Protocol deltas

| Aspect | MPP | x402 |
| --- | --- | --- |
| Selected when the 402 carries | `WWW-Authenticate: Payment` | `PAYMENT-REQUIRED` (and no `WWW-Authenticate: Payment`) |
| Command prefix | `inflow mpp …` | `inflow x402 …` |
| Matching model | The seller's challenge **pins the rail** - the buyer does not choose scheme/network/asset | Pay where the x402 `accepts` ∩ `supported.kinds` is non-empty |
| Payment selection | `--payment-method`, `--intent`, `--currency`, `--rail`; `--instrument-id` selects a linked card | `--scheme`, `--network`, `--asset`, `--asset-name`; `--instrument-id` selects a linked card |
| Resource completion command | `inflow mpp fetch <transaction_id> <url>` | `inflow x402 fetch <transaction_id> <url>` |
| Replay header used by Fetch | `Authorization: Payment <credential>` plus a non-colliding AEP credential when required | `PAYMENT-SIGNATURE: <encoded_payload>` plus a non-colliding AEP credential when required |
| Diagnostic credential file flag | `--credential-file <path>` on `status` | `--payload-file <path>` on `status` |
| Idempotency | - | `--payment-id` (see Step 2) |
| Cancel uses | `approval_id` | `approval_id` |
| Protocol-specific error codes | `PAYMENT_FAILED`, `PAYMENT_EXPIRED`, `PAYMENT_NOT_ACCEPTED` | `APPROVAL_TIMEOUT`, `APPROVAL_FAILED`, `APPROVAL_CANCELLED` |

Throughout this section `<mpp|x402>` means "use your protocol's prefix." For the exact parameters and output shape of any command below, run `inflow <command> --schema`.

### Step 1: Pre-flight evaluation

```bash
# 1. Inspect the URL; supply request parameters when the endpoint requires them
inflow inspect <url>

# (Already have the raw 402 header from a prior response? Decode it directly instead of re-probing:)
inflow <mpp|x402> decode '<402 header value>'

# 2. List what the buyer's account can pay with (use the protocol from `detected`)
inflow <mpp|x402> supported

# 3. For balance-funded crypto payments only, check the candidate currency/asset(s)
inflow balances list
```

`inflow inspect` returns what the seller accepts under its `mpp` and `x402` keys. Interpret amounts and assets according
to the payment method or scheme: blockchain payments identify the asset by its network-specific identifier, such as a
token contract address or mint, and use that asset's atomic units. InFlow x402 `balance` and `instrument` payments use
currency codes such as `USDC` or `USD` and amounts scaled to 18 decimal places (`"1000000000000000000"` means one unit
of the currency). Do not interpret x402 Instrument amounts as CARD's integer cents. `decode` parses a single raw header
you already hold (and also accepts a base64url credential / receipt). `supported` returns what the account can pay with;
`balances list` returns `available` per currency. Run the commands to see the exact shapes.

For CARD, MPP `inflow` Instrument, or x402 `instrument` offers, skip wallet balance checks and funding instructions.
Follow [Paying with a linked card](#paying-with-a-linked-card). For balance-funded crypto payments, decide whether you
can pay using this table:

| Condition | Meaning | Action |
| --- | --- | --- |
| No payable match between the seller and the buyer's `supported` methods | No payable rail | Stop → `NO_INFLOW_MATCH`. Tell the user the seller's rails aren't supported by their account. |
| A match exists, but `balances.available < amount` for every match | Right rail, not enough funds | Stop → run `inflow deposit-addresses list`, surface the address(es) in full, ask the user to fund a matching network. |
| A match exists **and** ≥1 match has `balances.available ≥ amount` | Payable | Proceed to Step 2. |

**Optional filters** narrow which offer to fulfil. They are AND-combined; an empty result fails with `NO_FILTERED_MATCH`.
MPP's `--instrument-id` selects a linked card and limits offers to CARD charges or `inflow` Instrument charges. Use
`--payment-method card` or `--payment-method inflow --rail instrument` to distinguish them. For exact parameters, run
`inflow <mpp|x402> pay --schema`.

### Paying with a linked card

- MPP `card` uses Visa Intelligent Commerce and requires a linked Visa card with a verified open allowance in the
  InFlow dashboard. The allowance belongs to the selected card and is not merchant-bound.
- MPP `inflow` with rail `instrument`, and x402 scheme `instrument`, use ordinary card processing without a VIC allowance.
- Neither uses an InFlow wallet balance. Omit `--instrument-id` to use the primary card, or provide the user's chosen
  linked-card UUID. Do not switch cards or payment methods after a rejection without asking the user.

Link cards and manage allowances in the dashboard for the authenticated environment: [sandbox](https://sandbox.inflowpay.ai)
or [production](https://app.inflowpay.ai), under Instruments. Do not collect card details through chat. The CLI does not
create allowances. A `supported` result identifies available payment methods, not whether the selected card has a usable
allowance.

To choose ordinary card processing explicitly, use the matching command:

```bash
inflow mpp pay <resource-url> --payment-method inflow --rail instrument --format json
inflow x402 pay <resource-url> --scheme instrument --format json
```

Add `--instrument-id <uuid>` to either command for a specific card. Without a method or scheme filter, card funding is
not guaranteed: x402 prefers balance, then exact, then Instrument; MPP selects from the seller's supported challenges.

For CARD, supply `--merchant-url` and `--merchant-country` (two-letter country code). `--merchant-name` overrides the
selected challenge's advertised merchant name. Use the merchant's official business information or information confirmed
by the user. Do not invent values, use buyer billing details, or assume the payment URL or a redirect is the merchant's
business website. If details are missing, ask the user and retry only after receiving them. The CLI does not prompt for
these fields interactively; `CARD_MERCHANT_REQUIRED` lists missing fields and flags before creating a transaction.

```bash
inflow mpp pay <resource-url> --payment-method card \
  --merchant-name 'Example Store' --merchant-url https://merchant.example \
  --merchant-country US --format json
```

CARD supports one-time USD/Visa payments, with a USD 0.50 minimum. Its wire amount is in integer cents: `"100"` means
USD 1.00. Do not pass `--rail`. Show the correct dollar amount to the user before initiating payment. Follow the normal
approval and Fetch steps below. CARD credentials are redacted from normal `pay` and `status` output. Do not export or
decode credentials for routine payment, and never place card numbers, cryptograms, or credentials in chat.

If issuance has an unknown outcome, retain the transaction ID and follow the server's instructions; do not start another
payment. If seller delivery returns `PAYMENT_REPLAY_OUTCOME_UNKNOWN`, do not automatically replay or create a replacement.
`INVALID_CARD_CREDENTIAL` likewise requires investigation, not another purchase. Resume an interrupted pending approval
with Fetch and the original transaction ID and request options.

**Decimal precision.** Keep amount strings and their units intact. Convert to matching units before comparing a price
with an available balance, using arbitrary-precision decimal arithmetic or integer atomic units. Do not compare numeric
strings lexicographically or convert payment amounts to a JavaScript `Number`.

### Step 2: Pay

Before initiating the call, summarize the intent to the user in chat: amount, currency, resource URL, and the method/rail (MPP) or scheme/network (x402). The user verifies the canonical details on the approval screen; the chat summary is what they read first. Example:

> "I'm about to pay 0.10 USDC to api.foo.dev for /dataset.csv. Requesting approval next."

**Fast path (recommended).** When the agent can block until the payment finishes, set `--interval N` and let the CLI run the whole flow in one call - probe, decode, prepare, await approval, replay against the seller, return the body:

```bash
inflow <mpp|x402> pay <url> --interval 5 --max-attempts 180
```

The result includes `outcome`, `transaction_id`, `response_status`, `settled`, and the seller body inline (or
`output_saved_to` if `--output-file` is set). MPP CARD reports `credential: "<redacted>"`; other MPP methods and x402 may
include `credential` or `encoded_payload`. The CLI has already sent the payment to fetch the body; **do not replay it
yourself or expose credential material in chat.** To surface `approval_url` before the call returns, add `--format jsonl`.
With the default `json` (or `toon`), the agent only sees the final buffered result.

**`outcome` values.** Branch on the result; an approval or verification response does not mean the purchase completed:

| `outcome` | Meaning | What to do |
| --- | --- | --- |
| `paid` | The seller returned 2xx to the payment-bearing request | Deliver the body; use the returned `settled` receipt details when reporting settlement. |
| `no-payment-required` | The resource wasn't paywalled, or was already paid | Tell the user nothing was charged; return the body |
| `replay-rejected` (x402) / `seller-rejected` (MPP) | The seller returned a non-2xx response to the payment-bearing request | Do NOT report success. Check the transaction status before deciding whether to retry. Do not report a refund unless it is confirmed. |
| `verification-required` | An ordinary Instrument payment needs bank verification | Present `verification_url` and follow [Bank verification](#bank-verification). Do not start another payment. |

An approval handoff returns transaction and approval fields with `_next`; it is not a `paid` result. For MPP, `ready`
means a credential is available, not that the seller charged the card. Likewise, an x402 signed payload is not a receipt.

**Two-step path.** Use this when the agent's host can't block I/O long enough for the user to approve (chat UIs that yield between turns). Drop `--interval`; the first call returns `transaction_id` + `approval_id` + `approval_url` + a `_next` Fetch command/tool input. Fetch owns polling and seller replay.

```bash
inflow <mpp|x402> pay <url>
# -> { "transaction_id": "txn_abc", "approval_id": "appr_xyz", "approval_url": "https://app.inflowpay.ai/approvals/appr_xyz", "_next": { "command": "<mpp|x402> fetch txn_abc <url> --interval 5 --max-attempts 180", "tool": "<mpp|x402>_fetch", "input": { "transactionId": "txn_abc", "resourceUrl": "<url>" } } }
```

Mind the two distinct ids: poll, replay, and resume all use `transaction_id`; **cancel uses `approval_id`** (`inflow <mpp|x402> cancel <approval_id>`). Both are returned by `pay`.

For non-GET requests, pass `--method`, `--data`, `--header` (repeatable):

```bash
inflow <mpp|x402> pay https://seller.example.com/api/widgets --method POST --data '{"sku":"widget-1"}' --header "X-Custom: value" --interval 5 --max-attempts 180
```

**Payment identifiers (x402 only).** `--payment-id <id>` supplies the payment-identifier extension value. Use a stable
opaque identifier for one intended purchase when your integration needs to provide it. It is not a transaction ID and
does not make repeating `pay` a resumption operation: transaction creation can create another approval even with the
same payment identifier. Resume using the original `transaction_id` and Fetch instead. After an ambiguous delivery
failure, confirm the payment and seller-operation outcome before any retry. Format constraints are available through
`inflow x402 pay --schema`.

```bash
inflow x402 pay <url> --payment-id "<stable-opaque-id>"
```

**Sensitive / binary output.** Fetch never exposes the one-time bearer credential (`credential` for MPP, `encoded_payload` for x402). For the seller's response body, `--output-file <path>` writes bytes to disk and replaces `body` / `body_base64` with `output_saved_to: <path>` - pair with `--no-show-body` for binary content (PDFs, images, audio, datasets) so bytes never appear inline as base64:

```bash
inflow <mpp|x402> pay https://api.foo.dev/dataset.csv --interval 5 --max-attempts 180 --output-file /tmp/dataset.csv --no-show-body
```

**Polling discipline.** Persist `transaction_id` as soon as `pay` returns it. Then:

- Present the approval URL, then resume with the InFlow MCP tool named in `_next.tool` using the values in `_next.input`, or run `inflow` followed by `_next.command`. Restore original request arguments when required. Fetch waits for the user's approval; it cannot approve for them. Do not start a second poll while the original command is still waiting.
- If polling is interrupted, resume with `inflow <mpp|x402> fetch <transaction_id> <url> --interval 5 --max-attempts 180`.
  A consumed credential does not justify another purchase. Before creating a replacement, confirm the original was not
  paid and obtain the user's approval. Unknown issuance or delivery outcomes require investigation, not a new transaction.
- If `POLLING_TIMEOUT` fires before approval, ask the user whether to keep waiting or cancel - don't silently restart the poll.
- If >12 minutes elapsed without a user response (≈3 min before the 15-minute approval window closes), surface that explicitly so they can act before the window closes.
- If the user aborts ("nevermind", "cancel that"), call `inflow <mpp|x402> cancel <approval_id>` before exiting. Otherwise the approval sits pending for 15 minutes and triggers phantom notifications in the user's InFlow app.

Fetch normally sends one payment-bearing request. For ordinary Instrument payments, the bank-verification flow can
make one additional request after InFlow confirms settlement, using the same credential and original request. AEP
authentication does not permit extra payment attempts. Fetch does not expose either credential in its output.
`PAYMENT_REPLAY_OUTCOME_UNKNOWN` means the seller might have received the credential; do not automatically replay it.

### Bank verification

This continuation applies to MPP `inflow` Instrument and x402 `instrument` payments, not VIC CARD issuance. InFlow
approval authorizes the purchase; the card issuer may then require the buyer to verify the charge in a browser.

When `outcome` is `verification-required`, present `verification_url` to the user. The URL leads to the authenticated
InFlow dashboard; never ask for bank credentials or verification codes in chat. Retain `transaction_id` and the original
resource URL, method, body, headers and output options.

- With `waiting: true`, the command is still checking the original transaction. Use `--format jsonl` when the host needs
  to receive the verification URL before that command finishes; `json` and `toon` buffer the result. There is no `_next`
  while waiting. Keep the original call running; do not start a second Fetch.
- With `waiting: false`, the command is not polling. After the user completes verification, run the returned Fetch
  continuation with a positive `--interval`. A `reason` of `timeout` means the local wait ended, not that the payment
  failed or was cancelled.
- When `_next.requires_original_request_options` is true, restore the original body and headers in
  `_next.input`. Polling and output options are already included. The CLI omits a copyable `_next.command` instead of
  echoing sensitive request data. Do not resume with an incomplete request or change the selected card.

After confirmed settlement, the waiting command retries the original seller request once with the same credential.
A second rejection stops the flow. In an interactive terminal, Enter opens the verification page and Escape stops the
wait without cancelling the charge. The `cancel` commands cancel pending InFlow approvals, not submitted card charges.

`INVALID_CARD_VERIFICATION` means the platform returned an unexpected transaction or verification URL; stop and report
it. `PAYMENT_STATUS_UNAVAILABLE` means the submitted payment could not be checked. `CARD_PAYMENT_FAILED` reports a
terminal payment failure. Preserve the original transaction in each case; none authorizes a replacement purchase.

### Limits

| Limit | Value |
| --- | --- |
| Approval window | 15 minutes from `pay` creating the transaction (`--timeout` overrides the polling deadline) |
| Polling stop condition | Polling ends at whichever fires first: `--max-attempts` (count, default `0` = unlimited) or `--timeout` (seconds, default `900` = the full 15-min window). The examples use `--interval 5 --max-attempts 180` (= 900 s) so a copied command covers the whole window - `--interval 5 --max-attempts 60` (= 300 s) would stop polling at 5 min, well before approval can land |
| Credential reuse | Do not reuse a credential for another purchase. The Instrument verification continuation uses the original credential to recover the original receipt. Existing subscriptions use fresh, short-lived credentials bound to the seller's current challenge. |

### Worked example (MPP)

A user asks the agent to fetch a paywalled dataset at `https://api.foo.dev/dataset.csv`.

Pre-flight: `inflow inspect <url>` reports `detected: ["mpp"]` with the seller's challenges; then `inflow mpp supported` (methods the buyer can pay with) and `inflow balances list`. The seller offers the `inflow` method in USDC; the user's 100.5 USDC balance covers the 0.10 USDC price. Summarize intent, then pay:

```bash
inflow mpp pay https://api.foo.dev/dataset.csv --interval 5 --max-attempts 180 --output-file /tmp/dataset.csv --no-show-body
# Persist transaction_id from the response in case polling is interrupted.
# Returns outcome "paid" with output_saved_to /tmp/dataset.csv.
```

> "Approval requested - confirm in the InFlow app: https://app.inflowpay.ai/approvals/appr_xyz
> I'll keep polling. 15-min window."

Once the result arrives:

> "Paid 0.10 USDC. Transaction txn_abc. Saved the dataset to /tmp/dataset.csv."

**Two-step variant** (host can't block): follow Step 2's two-step path; `mpp fetch` polls, attaches `Authorization: Payment`, and returns the resource body without exposing the credential.

### Worked example (x402)

A user asks the agent to fetch a paywalled article at `https://api.foo.dev/article-3`.

Pre-flight: `inflow inspect <url>` reports `detected: ["x402"]`; the intersection lands on `exact` × `solana:mainnet`, and the user's 100.5 USDC balance easily covers the 0.10 USDC the seller requires. Proceed.

> "I'm about to pay 0.10 USDC on Solana mainnet to api.foo.dev for /article-3.
> Your balance is 100.5 USDC - plenty. Requesting approval next."

```bash
inflow x402 pay https://api.foo.dev/article-3 --payment-id "<stable-opaque-id>" --interval 5 --max-attempts 180
# Persist transaction_id from the response in case polling gets interrupted.
# Returns outcome "paid"; body contains the article JSON.
```

> "Approval requested - confirm in the InFlow app: https://app.inflowpay.ai/approvals/appr_xyz
> I'll keep polling. 15-min window."

Once the result arrives:

> "Paid 0.10 USDC. Transaction txn_abc. Server returned: 'How to brew coffee - ...'"

**Two-step variant** (host can't block): follow Step 2's two-step path; `x402 fetch` polls, attaches `PAYMENT-SIGNATURE`, and returns the resource body without exposing the encoded payload.

## Subscribing to an MPP resource

Use this flow only when `inflow inspect <url>` shows an MPP challenge with `intent: subscription`. Before initiating it, show the user the recurring amount and currency, billing period, expiration, seller reference when present, resource URL, and settlement rail. Each subscription option includes a stable `option_id` derived from its recurring terms. If multiple options are available, ask the user which one they want and pass that identifier to `mpp subscribe`; never select the first option implicitly.

```bash
inflow mpp subscribe <url> --option-id <option_id> --interval 5 --max-attempts 180
```

The user approves the immutable recurring terms. Successful activation settles the first period. Later access uses `subscriptions fetch`, which obtains a fresh credential for the current seller challenge.

If the host cannot wait for approval, omit `--interval`, retain the returned `transaction_id`, and follow the returned `_next` using the two-step payment instructions above. `mpp fetch` polls, activates the subscription, and returns the resource. After activation, use `subscriptions fetch <subscription_id> <url>`; the server decides whether the current billing period is already paid or requires one new charge.

Manage the buyer's subscriptions with:

```bash
inflow subscriptions list
inflow subscriptions list --status active
inflow subscriptions get <subscription_id>
inflow subscriptions fetch <subscription_id> <url>
inflow subscriptions cancel <subscription_id>
```

Obtain explicit user confirmation immediately before cancelling a subscription. Cancellation is immediate and does not refund a paid period. A cancelled subscription cannot obtain another access credential.
Treat `PAST_DUE` as recoverable through a later collection retry; `EXPIRED`, `CANCELLED`, `REVOKED`, and `FAILED` are terminal.

### MPP errors

All errors in agent mode are JSON with `code` and `message` fields and exit code 1. MPP-specific codes (shared codes are in [§ Shared errors](#shared-errors)). "What to tell the user" is the prompt to surface - don't dump the raw error:

| Error code | Recovery | What to tell the user |
| --- | --- | --- |
| `PAYMENT_FAILED` | Read the message and check `inflow mpp status <transaction_id>` when an ID exists. An unknown issuance outcome must not trigger another payment. | Explain the specific failure and the server's next step; do not assume nothing was charged. |
| `PAYMENT_EXPIRED` | Check the original transaction. Only propose a replacement after establishing it was not paid and obtaining the user's approval. | "The credential is expired. I'll check the original purchase before suggesting another payment." |
| `PAYMENT_NOT_ACCEPTED` | Inspect the rejection and original payment outcome. Do not automatically create another payment or change funding. | "The seller rejected the payment-bearing request. That alone does not establish whether a charge occurred." |

### x402 errors

All errors in agent mode are JSON with `code` and `message` fields and exit code 1. x402-specific codes (shared codes are in [§ Shared errors](#shared-errors)). "What to tell the user" is the prompt to surface - don't dump the raw error:

| Error code | Recovery | What to tell the user |
| --- | --- | --- |
| `APPROVAL_TIMEOUT` | Read the original transaction with `x402 status`. A local wait timeout is not proof that the approval expired; resume the same transaction if it is pending. | "The wait ended before a signed payment was available. I'll check the original transaction before suggesting what to do next." |
| `APPROVAL_FAILED` | Read the returned reason and original transaction. Do not assume insufficient wallet funds for a card payment or switch funding automatically. | Explain the returned failure without inventing a cause. |
| `APPROVAL_CANCELLED` | Stop this purchase. Ask before creating a replacement. | "The approval was declined or cancelled. No replacement payment was started." |
| `INVALID_PAYMENT_ID` | `--payment-id` violated the format (see `inflow x402 pay --schema`). Adjust or omit the payment id. | - |

---

## Security & data handling

Applies to both protocols.

- Treat OAuth tokens and API keys as secrets - never echo them. Use Fetch for approved payments so one-time payment credentials are attached to the seller request without being pasted back to the user.
- Respect `/agents.txt` and `/llm.txt` on sites you browse.
- Avoid suspicious 402 endpoints - if the domain doesn't match what the user asked to pay, or the price is different from expectation, stop and ask.
- When displaying deposit addresses to the user, print the full address (don't truncate). Truncating breaks copy-paste.

## Shared errors

These apply to both protocols (in addition to each section's protocol-specific codes). All are JSON with `code` and `message` and exit code 1. Where a command is protocol-specific, use your prefix (`<mpp|x402>`). "What to tell the user" is the prompt to surface - don't dump the raw error:

| Error code | Recovery | What to tell the user |
| --- | --- | --- |
| `VAULT_LOCKED` | Stored authentication status is unavailable. Ask the user to run `inflow vault unlock` themselves in a terminal, then retry. | "Your InFlow vault is locked. Please unlock it in your terminal, then I can check authentication again." |
| `NOT_AUTHENTICATED` | No saved device token and no `--api-key` / `INFLOW_API_KEY` configured. Run `inflow auth login` or set the API key env var. | - |
| `NO_INFLOW_MATCH` | No supported match. Compare the seller's offers with `supported`; do not prescribe a wallet deposit for a card offer. | Explain which advertised payment method cannot be used. |
| `NO_FILTERED_MATCH` | A `pay` filter emptied the candidate list. Loosen the filter (flags per the delta table), or re-check the seller's unfiltered options with `inflow inspect <url>`. | "Your filter removed every option the seller accepts. Loosen it or re-check the seller's options with `inflow inspect`." |
| `INVALID_402` / `DECODE_FAILED` | Seller returned 402 but the protocol's header was missing (`INVALID_402`) or unparseable (`DECODE_FAILED`). Verify the URL is payable; pass the raw header to `inflow <mpp|x402> decode` for the detailed parse error. | - |
| `POLLING_TIMEOUT` | `--interval` polling reached its max-attempts or timeout. Retryable - resume with `inflow <mpp|x402> fetch <transaction_id> <url> --interval 5 --max-attempts 180`. | "Still waiting on your approval - want me to keep polling, or cancel the request? (`inflow <mpp|x402> cancel <approval_id>` cancels it.)" |
| `PAYMENT_REPLAY_OUTCOME_UNKNOWN` | A credential-bearing seller request had an indeterminate transport failure. Do not automatically replay. | "The seller request may have received the payment credential, but the connection failed before we got a reliable response. I won't retry automatically because the credential may be consumed." |
| `api_error` | Non-2xx from the InFlow API on the plain data calls (`balances`, `deposit-addresses`); discriminate on `httpStatus`. `401` - saved auth rejected, re-run `inflow auth login`. `426` (`VERSION_UNSUPPORTED`) - upgrade and retry. `5xx` - server-side; wait and retry. (Note: `pay`/`status` rejections instead surface the server's own code, e.g. `INSUFFICIENT_FUNDS`, or the protocol's terminal code - not `api_error`.) | - |
| `VERSION_UNSUPPORTED` / HTTP 426 | Installed `inflow` CLI is below the minimum supported version. Install the current release from https://inflowcli.ai/, then retry; don't retry on the old version. | - |
| `transport_error` | Network failure - check connectivity; retry. | - |

## Out of scope

This skill covers programmatic HTTP 402 payments (MPP and x402) only. It does NOT handle:

- **Traditional merchant checkouts** No PANs (credit card forms, hosted checkouts).
- **Card issuance** or wallet management beyond `balances list` and `deposit-addresses list`.
- **Refunds, disputes, chargebacks** - handled out of band via support.
- **Peer-to-peer transfers** between users or wallets.
- **FX / currency conversion.** Buyer logic matches the seller's accepted rails against the account's supported assets.

For any of the above, point the user to https://app.inflowpay.ai or support.

## Further docs

- MPP protocol: https://mpp.dev
- x402 protocol: https://x402.org
- InFlow: https://app.inflowpay.ai
