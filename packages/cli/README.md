# @inflowpayai/inflow

The InFlow binary for agentic discovery, onboarding, and [MPP](https://mpp.dev) / [x402](https://x402.org) payments. See
the [repository README](../../README.md) for project-level context.

Install InFlow from [inflowcli.ai](https://inflowcli.ai/) to run commands, start MCP, or manage credentials. The hosted
installers support macOS and Linux through `install.sh`, Windows through `install.ps1`, and cross-platform shell
delegation through `/cli`.

Every command supports a TTY rendering (Ink) and an agent rendering via `--format <json|toon|yaml|md|jsonl>`. The TTY
view is what you get by default in an interactive terminal; the structured formats are what an AI assistant or pipeline
should request.

Use `inflow inspect <url>` when the protocol is unknown. Use the dedicated `odp`, `aep`, `mpp`, or `x402` command after
inspection identifies the next step. Read-only discovery and inspection commands work without a buyer login; enrollment,
credential management, and payment commands use the authenticated InFlow account and encrypted vault.

For host-specific skill and MCP installation, see the repository's
[surface install and testing guide](https://github.com/inflowpayai/inflow-cli/blob/main/docs/development/surfaces-and-testing.md).

## Command index

| Command                                                          | Purpose                                                                                                                           |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `inflow auth login`                                              | Run the OAuth device flow to authenticate. Saves a refreshable access token.                                                      |
| `inflow auth logout`                                             | Revoke eligible remote credentials and reset local authentication, vault, and cached state.                                       |
| `inflow auth status`                                             | Show which credential the CLI would use, plus the active environment and resolved API URL.                                        |
| `inflow vault status`                                            | Show whether the encrypted local credential vault is initialized, locked, and available.                                          |
| `inflow vault unlock`                                            | Initialize or unlock the local vault from a human-controlled terminal.                                                            |
| `inflow vault lock`                                              | Lock the local vault.                                                                                                             |
| `inflow vault policy`                                            | Show the vault idle and sleep-lock policy.                                                                                        |
| `inflow vault set-policy`                                        | Change the vault idle and sleep-lock policy.                                                                                      |
| `inflow vault change-passphrase`                                 | Rewrap the vault data key under a new PIN or passphrase.                                                                          |
| `inflow vault reset`                                             | Remove the local vault database, bootstrap material, policy, and runtime state.                                                   |
| `inflow balances list`                                           | List the authenticated user's balances.                                                                                           |
| `inflow deposit-addresses list`                                  | List the user's configured deposit addresses, grouped by network.                                                                 |
| `inflow inspect <url>`                                           | Inspect a URL for discovery, enrollment, and payment protocols without taking an action.                                          |
| `inflow directory search`                                        | Search the directory for Services and Collections.                                                                                |
| `inflow directory suggest <prefix>`                              | Find matching Service and Collection names.                                                                                       |
| `inflow odp inspect <service>`                                   | Inspect a service's capabilities.                                                                                                 |
| `inflow odp collections list <service>`                          | List collections from a service in terse form.                                                                                    |
| `inflow odp collections search <service>`                        | Search collections from a service in terse form.                                                                                  |
| `inflow odp collections get <service> <id>`                      | Get full collection details.                                                                                                      |
| `inflow odp offerings list <service>`                            | List offerings from a service in terse form.                                                                                      |
| `inflow odp offerings capabilities <service>`                    | Resolve the filters and sorts available for offering search.                                                                      |
| `inflow odp offerings search <service>`                          | Search offerings from a service with structured filters.                                                                          |
| `inflow odp offerings get <service> <id>`                        | Get full offering details, including resolved schemas, actions, and issues.                                                       |
| `inflow odp offerings discover`                                  | Find offerings across services selected from the directory.                                                                       |
| `inflow odp actions resolve <service> <offering-id> <action-id>` | Resolve an offering's action into an executable request without invoking it.                                                      |
| `inflow aep inspect <service>`                                   | Inspect an Agent Enrollment Protocol Service. No InFlow login is required.                                                        |
| `inflow aep fetch <resource-url>`                                | Fetch a resource anonymously or complete AEP authentication, approval, credential storage, and replay in one invocation.          |
| `inflow aep enroll <service>`                                    | Provision or reuse a Service-scoped Agent identity and enroll after InFlow approval.                                              |
| `inflow aep status <service>`                                    | Fetch Service lifecycle status and list non-secret local credential summaries.                                                    |
| `inflow aep grant <service>`                                     | Request a fresh Service credential and store it locally without exposing its secret.                                              |
| `inflow aep revoke <service>`                                    | Revoke all Service credentials, or one credential or grant type.                                                                  |
| `inflow x402 pay <url>`                                          | Create an x402 payment transaction and optionally poll/replay inline.                                                             |
| `inflow x402 fetch <tx> <url>`                                   | Resume an x402 transaction, wait for a signed payload when configured, and fetch the seller resource.                             |
| `inflow x402 inspect <url>`                                      | Read-only probe. Show the seller's `PAYMENT-REQUIRED` accepts for a URL — no auth, no payment.                                    |
| `inflow x402 status <transactionId>`                             | Poll the signing state of an in-flight transaction without contacting the seller.                                                 |
| `inflow x402 cancel <approvalId>`                                | Best-effort cancel of an in-flight approval. Requires authentication; success does not verify the server-side approval state.     |
| `inflow x402 decode <header>`                                    | Decode a raw `PAYMENT-REQUIRED` header value. No auth required.                                                                   |
| `inflow x402 supported`                                          | List the buyer-side `(scheme, network)` capability cache.                                                                         |
| `inflow mpp pay <url>`                                           | Create an MPP payment transaction and optionally poll/replay inline.                                                              |
| `inflow mpp subscribe <url>`                                     | Approve and activate an MPP subscription.                                                                                         |
| `inflow mpp fetch <tx> <url>`                                    | Complete a ready or pending MPP payment and fetch the seller resource.                                                            |
| `inflow mpp inspect <url>`                                       | Read-only probe. Parse the seller's MPP `Payment` challenge(s) for a URL — no auth, no payment.                                   |
| `inflow mpp status <transactionId>`                              | Poll the buyer-side state of an in-flight MPP transaction without contacting the seller.                                          |
| `inflow mpp cancel <approvalId>`                                 | Best-effort cancel of an in-flight MPP approval. Requires authentication; success does not verify the server-side approval state. |
| `inflow mpp decode <value>`                                      | Decode a `WWW-Authenticate: Payment` header, or a base64url credential / receipt. No auth required.                               |
| `inflow mpp supported`                                           | List the methods the buyer can pay with — by intent, settlement rail, and currency.                                               |
| `inflow subscriptions list`                                      | List your subscriptions.                                                                                                          |
| `inflow subscriptions get <id>`                                  | View a subscription's details.                                                                                                    |
| `inflow subscriptions fetch <id> <url>`                          | Fetch a resource using a fresh short-lived subscription authorization.                                                            |
| `inflow subscriptions cancel <id>`                               | Cancel a subscription immediately.                                                                                                |

## Global flags

These flags are pre-extracted from `process.argv` before subcommand dispatch, so they work positionally —
`inflow --sandbox balances list` is the same as `inflow balances list --sandbox`. Resolution order for each setting is:
**CLI flag > environment variable > saved config > built-in default**.

| Flag                                         | Env var                | Notes                                                                                                                                                                                                                                                                              |
| -------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--api-key <key>`                            | `INFLOW_API_KEY`       | Use an API key instead of the saved OAuth access token. When both are present, the flag wins for this invocation; `auth login` persists what it saw.                                                                                                                               |
| `--auth <path>`                              | `INFLOW_AUTH_FILE`     | Identify a legacy plaintext credentials file for deletion during secure-storage cutover. It is not a credential backend.                                                                                                                                                           |
| `--auth-base-url <url>`                      | `INFLOW_AUTH_BASE_URL` | Override the OAuth endpoint.                                                                                                                                                                                                                                                       |
| `--base-url <url>` (alias: `--api-base-url`) | `INFLOW_BASE_URL`      | Override the environment-derived API URL. Takes precedence over `--environment`.                                                                                                                                                                                                   |
| `--bootstrap`                                | —                      | Print the agent setup guide (install, authenticate, load a playbook) to stdout and exit. The same text is served at `https://inflowcli.ai/skill.md`.                                                                                                                               |
| `--environment <production\|sandbox>`        | `INFLOW_ENVIRONMENT`   | Selects the public environment. Defaults to `production`.                                                                                                                                                                                                                          |
| `--format <json\|toon\|yaml\|md\|jsonl>`     | —                      | Agent rendering. Default is TTY (Ink).                                                                                                                                                                                                                                             |
| `--sandbox`                                  | —                      | Shorthand for `--environment sandbox`.                                                                                                                                                                                                                                             |
| `--skill [name]`                             | —                      | Print a bundled skill body to stdout and exit. Available skills are `agentic-discovery`, `agentic-enrollment`, and `agentic-payments`; the default is `agentic-payments`. No frontmatter. Use for piping into a system prompt on MCP hosts that don't natively load skills.        |
| `--verbose`                                  | —                      | Log every HTTP request/response to stderr.                                                                                                                                                                                                                                         |
| —                                            | `INFLOW_HTTP_PROXY`    | Route every outbound HTTP request through this proxy URL. Requires the optional `undici` peer (`npm install undici`); the SDK throws `InflowConfigurationError` at first request when the env var is set but `undici` is missing. Ignored when the caller passes a custom `fetch`. |

## `auth`

The CLI authenticates via the OAuth device-authorization flow. After `auth login` completes, access and refresh tokens
are encrypted in the local InFlow vault. The `inflow-core` access-token provider refreshes automatically when the access
token expires.

API keys are an alternative: pass `--api-key` or set `INFLOW_API_KEY` once and the CLI sends `X-API-KEY` on every
request, bypassing the device flow entirely. Mutually exclusive with the OAuth path on a given invocation.

Before the first credential-bearing command, initialize the vault with `inflow vault unlock`. The unlock factor is
accepted only from a human-controlled terminal. Agent, structured, and MCP executions return a human-action error when
the vault is uninitialized or locked; they do not accept the factor as input.

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

Attempts eligible remote credential revocation, stops the local vault daemon, and removes local authentication,
encrypted vault, user metadata, and public cache state. Idempotent: safe to call when already logged out.

### `auth status`

```bash
inflow auth status              # TTY
inflow auth status --format json
inflow auth status --probe      # validate the token via GET /v1/users/self
```

Reports which credential the CLI would use (OAuth access token, API key, or none), the active environment, and the
resolved API URL — including the SDK's built-in defaults when nothing is overridden.

A runtime `--api-key` or `INFLOW_API_KEY` can be reported without opening the local vault. Without a runtime API key, a
locked vault returns a non-zero `{ code: "VAULT_LOCKED", message }` error because the stored authentication state is
unavailable. Unlock the vault in a human-controlled terminal and retry.

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

## `openapi operations`

Read a public JSON OpenAPI 3.x document without login, vault access, enrollment, payment, or operation execution:

```bash
inflow openapi operations list https://stableenrich.dev --format json
inflow openapi operations list https://stableenrich.dev/openapi.json --refresh --format json
inflow openapi operations list https://nano.blockrun.ai/openapi.json --collection-id kalshi --format json
inflow openapi operations list https://api.orthogonal.com/openapi.json --tag "Abstract Avatars" --format json
inflow openapi operations get https://example.com/openapi.json --method POST --path /search --format json
inflow openapi operations get https://example.com/openapi.json --operation-id search --format json
```

Origins use bounded discovery, including `/openapi.json` and `/v1/openapi.json`. Multiple candidates require an exact
document URL; an exact URL never silently falls back to another document. `--refresh` revalidates cached documents and
rediscovers an origin. Public document caches honor HTTP freshness and do not contain operation responses or
credentials.

`list` returns `{ source: { type: "openapi", url }, title, openapi, items, limitations }`. Each item contains `method`,
`path`, optional `operationId`, optional `summary`, and optional provider `tags`. `get` returns
`{ source, operation, limitations }`. Its operation contains `method`, `path`, optional `operationId`, `summary`,
`description`, `requestBody`, and the `servers`, `parameters`, `security`, `securitySchemes`, and `limitations` fields.
Server records retain their reference `baseUrl` when needed to interpret relative addresses. Both commands read the
entire source document for operation definitions. `list --collection-id` additionally reads the selected Collection's
membership from the configured Directory and filters by method/path. `--tag` filters locally by an exact, case-sensitive
provider operation tag. Both filters combine by intersection; neither filter means the full list. Provider tags and
Directory Collection IDs are distinct. Human output caps summaries and tags; structured output keeps their full values.
Collection selection requires no login and sends no credentials to the Directory.

`OPENAPI_COLLECTION_UNAVAILABLE` means the Collection is not published in the configured Directory.
`OPENAPI_COLLECTION_LOOKUP_FAILED` means its membership could not be retrieved or validated. `OPENAPI_COLLECTION_STALE`
means selected operations are missing from the provider document: retry with `--refresh`; the Directory may also need to
refresh the Service. None of these failures falls back to the full operation list.

Use method/path together or a unique operation identifier alone. Errors include `OPENAPI_SELECTOR_INVALID`,
`OPENAPI_OPERATION_NOT_FOUND`, `OPENAPI_OPERATION_AMBIGUOUS`, `SOURCE_NOT_FOUND`, `SOURCE_AMBIGUOUS`,
`SOURCE_UNAVAILABLE`, and `OPENAPI_READ_FAILED`. Ambiguous-source errors list the candidate URLs. No automatic operation
request or payment follows a successful read. Security requirements preserve alternatives between objects and combined
requirements within each object; provider login and SIWX are not automated. An empty security list does not prove that
an endpoint is free or publicly callable.

### Call an OpenAPI operation

```bash
inflow openapi operations call https://example.com/openapi.json \
  --method POST --path /search --data '{"query":"weather forecasts"}' --format json
```

`call` accepts the preparation inputs below, plus `--timeout` (seconds, default 30, maximum 900), `--max-response-bytes`
(default and maximum 16777216), `--no-show-body`, and `--output-file`. It requires no InFlow login or vault access.
Explicit headers and declared API keys are sent to the selected server; no credentials are obtained automatically.
Requests and responses are not cached. An explicit output file saves response bytes and overwrites an existing file.

Payment information appears as `payment` on each `list` item and `get` operation, and in `prepare` output. It contains
`advertised`, recognized `protocols` (`mpp`, `x402`), MPP `offers`, `response402`, and explanatory `notes`. MPP
single-offer and `offers` declarations are recognized, as are operation-level `x-payment-info.protocols` string or
named-object arrays. An explicit `x-payment-required: true` without a recognized protocol is reported as unknown payment
support. Service-wide metadata, unused security schemes, and a documented 402 alone do not mark every operation as paid.
Missing declarations mean **payment not advertised**, not free access.

- Advertised paid operation: return `payment-required` with `sent: false`, without sending the operation.
- Unmarked operation: send exactly one request. A runtime 402 returns `payment-required` with `sent: true`.
- A 401 with an AEP challenge returns `authentication-required` and an explicit `aep fetch` handoff. This command does
  not enroll or obtain an AEP grant. Other provider authentication is not automated.
- Success returns `response`. Other HTTP failures, including redirects, return `OPENAPI_HTTP_ERROR` with the result
  under error `details`. Redirects are not followed, and requests are not automatically retried.

The result fields are:

| Field                                           | Meaning                                                                                                                                    |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `outcome`, `sent`                               | Result classification and whether the operation was sent.                                                                                  |
| `source`, `operation`                           | OpenAPI source and selected operation, as in preparation.                                                                                  |
| `request`, `redactions`                         | Redacted request preview and recognized credential locations. Arbitrary body data is not redacted.                                         |
| `status`, `content_type`, `response_size_bytes` | Present after a response; content type can be null.                                                                                        |
| `body` / `body_base64` / `output_saved_to`      | Text, binary base64, or saved response location. Body fields are absent with `--no-show-body`; explicit output files still receive bytes.  |
| `payment`                                       | Full advertised metadata before sending, or `{protocols: [...]}` from a runtime 402. Empty protocols mean no recognized payment challenge. |
| `next`                                          | Explicit handoffs: `command` words, `url`, `options` (`method`, repeatable `header`, optional `data`), `requiredInputs`, and `message`.    |

Choose between the MPP and x402 handoffs when both are advertised; no protocol is selected automatically. Use the
original values for `requiredInputs`, never the redacted placeholders. Payment commands request a fresh challenge; they
do not resume the exact response received by `call`. Advertised prices and protocols are guidance, not a promise that a
particular offer or provider-specific signing requirement is supported. The runtime challenge determines payment terms.
Preparation includes the same payment handoffs in `next`.

`OPENAPI_CALL_OUTCOME_UNKNOWN` means the request or response transfer failed: the operation may have completed. Do not
automatically repeat it. `OPENAPI_RESPONSE_TOO_LARGE` likewise does not imply failure at the server.
`OPENAPI_OUTPUT_WRITE_FAILED` means the response was received but could not be saved; repeating the operation is not a
safe way to retry a local file write. `OPENAPI_CALL_CANCELLED` means cancellation occurred before sending. Invalid core
call limits produce `OPENAPI_CALL_INPUT_INVALID`; command options also validate these limits before execution.

### Prepare a request without sending it

Use the same source and operation selector as `get`, with explicit request inputs:

```bash
inflow openapi operations prepare https://example.com/openapi.json \
  --method POST --path '/items/{id}' \
  --parameters '{"path":{"id":"123"},"query":{"limit":10}}' \
  --data '{"query":"weather forecasts"}' --format json
```

`--parameters` is a JSON object with optional `path`, `query`, and `header` objects. It retains JSON types rather than
guessing whether text means a number or a boolean. Use repeatable `--header 'Name: Value'` for literal headers. Declared
header values supplied through `--parameters` use OpenAPI simple serialization with percent-encoding; `--header` values
are already serialized literal text and are not percent-encoded. Do not provide the same header through both inputs.
Unknown path/query parameters are errors; declared query API keys can also be supplied. Header names are
case-insensitive. Cookies and transport-controlled headers such as Host and Content-Length are not accepted.

The document URL identifies the description, not necessarily the execution server. A single advertised server is
selected automatically. Multiple servers require `--server 1` (or another one-based number shown by `get` and the
error). Use `--server-variables '{"region":"eu"}'` to override declared server variables; otherwise their declared
defaults apply. Request parameter/body defaults and examples are not inserted. Relative server URLs resolve against the
document that defines them. Preparation accepts public HTTPS server URLs without credentials, fragments, or queries.

Supported encodings are simple path/header parameters, form query parameters, scalar values, arrays of scalars, and JSON
bodies. Query arrays use repeated names unless `explode: false` selects comma separation. A single advertised JSON media
type is selected automatically; choose among multiple types with `--header 'Content-Type: application/…+json'`. Required
fields, basic types, safe integers, enums and constants are checked. This is not full JSON Schema validation:
constraints such as patterns, string lengths and numeric bounds are not checked. Optional omitted inputs are not sent.

Parameter and request-body object references use the document reader's bounded reference support. Schema references and
composition, object-valued parameter encodings, matrix/label/deepObject styles, `allowReserved: true`, content-based
parameters, multipart/form/XML/binary bodies, and GET/HEAD bodies are not supported for preparation. If a supplied or
required input needs unsupported handling, preparation fails instead of returning a request containing placeholders.
Document inspection remains available.

JSON output has these fields:

| Field            | Contents                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------- |
| `outcome`        | `"request-prepared"`; nothing was sent.                                                   |
| `source`         | `{ type: "openapi", url }`, identifying the source document.                              |
| `operation`      | `method`, documented `path`, and optional `operationId`.                                  |
| `request`        | `method`, constructed `url`, lowercase-name `headers`, and optional JSON-text `body`.     |
| `authentication` | Advertised `requirements` and `verified: false`; credentials are not acquired or checked. |
| `redactions`     | Array of `{ location: "header" \| "query", name }` identifying redacted credentials.      |
| `limitations`    | Document/operation limitations and the scope of preparation checks.                       |

Human and JSON previews redact Authorization, Proxy-Authorization, and API-key header/query locations explicitly
declared by the document. Other fields, including body contents, are not scanned for secrets or personal data. A
redacted preview is not a complete executable request: keep the original inputs for deliberate execution. Prepared
requests and supplied inputs are not cached or logged by preparation. Documents still use the public discovery cache.
Command-line inputs can appear in shell history or operating-system process inspection.

Errors follow the ordinary CLI error format, with `retryable: false`: `OPENAPI_INPUT_REQUIRED` identifies missing
inputs; `OPENAPI_INPUT_INVALID` identifies malformed or conflicting inputs; `OPENAPI_SERVER_REQUIRED` lists server
choices; `OPENAPI_SERVER_INVALID` identifies invalid selections/addresses; `OPENAPI_PREPARATION_UNSUPPORTED` explains
unsupported construction. Discovery and operation-selection errors retain their existing codes. Both human and agent
modes report the error without prompting, sending the operation, enrolling, or paying.

## `odp`

ODP discovery has two stages. The canonical directory finds Services and indexed Collections from their metadata;
Collection and Offering commands then query a selected Service's catalog directly. The directory does not store or
search a global Offering catalog. Directory search and `odp inspect` are public operations. Catalog and Action commands
use the existing AEP runtime when Service authentication is required.

The following agent workflow is directly runnable when the canonical directory contains a matching Service. It uses `jq`
to pass identifiers from one structured response to the next:

```bash
set -eu

directory_json=$(inflow directory search gpu --source odp \
  --operation search-offerings \
  --format json)
service_origin=$(printf '%s' "$directory_json" | jq -er '[.items[] | select(.type == "service" or .type == "collection")][0].service.service_origin')

inflow odp inspect "$service_origin" --format json

offerings_json=$(inflow odp offerings search "$service_origin" gpu --format json)
offering_id=$(printf '%s' "$offerings_json" | jq -er '.items[0].id')
offering_json=$(inflow odp offerings get "$service_origin" "$offering_id" --format json)
printf '%s\n' "$offering_json" | jq .

action_id=$(printf '%s' "$offering_json" | jq -r '.offering.actions[0].id // empty')
if [ -n "$action_id" ]; then
  inflow odp actions resolve "$service_origin" "$offering_id" "$action_id" --format json
fi
```

Directory search JSON contains `items`, optional `facets`, optional `next`, and optional `issues` for skipped invalid
results. Known items contain `type`, `indexed_at`, and `service` (including `service_id`, `service_origin`, and any
advertised `protocols` and `source`). `source` contains `type`, the exact document `url`, and `x402_discovery`, which
indicates a supporting discovery file, not a verified payment capability. Collection items also contain `collection.id`,
`collection.name`, and an optional description. Only native `source.type: "odp"` Collections can use the owning origin
and Collection ID with `odp collections get`. For `openapi`, pass `service.source.url` to `openapi operations list`; an
imported Collection can select its operations using `--collection-id <collection.id>`. Service items can carry
`available_through`; structured output retains it, but the text table does not display attribution or protocols. Unknown
types retain `resource_type` and `raw` and are displayed as unsupported, not treated as executable targets.

Facets count matching results, including Collections. The mixed endpoint returns at most 100 results; an absent `next`
does not mean every match was returned. `directory suggest` returns `{ "items": ["name"] }`: names of Services and
Collections whose indexed metadata matches the input, not necessarily names that begin with that input. Both commands
accept `--source`, `--keyword`, `--operation`, `--payment`, and `--with-aep`. Repeat `--source odp` or
`--source openapi` to select formats; omit it to include all formats. Unknown source formats remain displayable but are
not ODP targets. `--with-aep` requires advertised AEP support; it does not check your enrollment or authenticate you.
For Collection results, these filters apply to the owning Service.

The text table's Target URL is the Service origin for ODP and the exact document URL for OpenAPI. Copy it into the
corresponding ODP or OpenAPI commands. Collections use their parent Service's target alongside their Collection ID. JSON
retains both the origin and source document URL. Repeated source values are combined without duplicates.

For example:

```bash
inflow directory suggest weather --with-aep --operation get-offering --payment mpp:inflow --format json
```

`offerings discover` remains Service-only and does not treat a Collection result as another Service.

An opaque continuation, when supplied, can be resumed without interpreting it:

```bash
page=$(inflow directory search gpu --format json)
next=$(printf '%s' "$page" | jq -r '.next // empty')
if [ -n "$next" ]; then
  inflow directory search --next "$next" --format json
fi
```

### Access, caching, and privacy

- A directory query is sent only to `https://api.inflowpay.ai`, or to `https://sandbox.inflowpay.ai` in the sandbox
  environment. The directory sees the query and Service-level filters, which also apply to a Collection's owning
  Service.
- Per-Service Collection, Offering, and Action requests are sent directly to that Service. `offerings discover` sends
  the Offering query and catalog filters to every selected Service within the configured bounds.
- The CLI does not send ODP analytics or command telemetry. Shell history, redirected output, and the selected remote
  Services remain outside the CLI's control, so queries and returned catalog data should be handled accordingly.
- AEP credentials are attached after a live Service challenge, or when existing AEP policy metadata establishes that
  authentication is required, and are not included in command output. Internal cache partitions are derived only for a
  verified current InFlow identity, are not credentials, and are not emitted. When the identity cannot be verified,
  catalog caching is disabled instead of sharing a response across principals.
- Service-controlled output is recursively stripped of ANSI escape sequences before TTY or structured rendering.
  `--verbose` does not print ODP AEP credentials, protected response bodies, or cache-partition identifiers.

### `directory`

```bash
inflow directory search gpu --keyword compute --payment mpp:inflow --format json
inflow directory suggest gp --limit 10 --format json
```

Directory search returns one page as `{ items, next?, facets?, issues? }`. Pass the opaque `next` value back through
`--next <value>` to continue; a continuation cannot be combined with a new query or filters. The SDK validates and
requests the continuation, so callers do not interpret or reconstruct it. `--sandbox` selects the canonical ODP sandbox
directory.

Suggestions return `{ items }`, where each item is a Service or Collection name matched through indexed metadata.

`--payment mpp` matches any Service advertising MPP. Add an ODP payment option after a colon to require a
Service-advertised option, such as `--payment mpp:solana` or `--payment x402:base`. Repeat the flag for alternatives.
Multiple options for one protocol are grouped into one directory filter; a broad protocol filter supersedes narrower
options for that protocol.

### `odp inspect`

```bash
inflow odp inspect https://compute.example --format json
```

Inspection fetches the Service's ODP well-known document and returns the validated document, effective capabilities,
canonical Service origin, resolved URLs, and freshness state.

Direct Collection, Offering, and Action commands verify the required operation against these capabilities before calling
an initial catalog endpoint. An unsupported operation returns `ODP_OPERATION_NOT_SUPPORTED`, includes the advertised
operations, and identifies the corresponding list command when listing is a valid alternative to search. Opaque
continuations remain bound to the operation that produced them and resume without a new capability decision.

### `odp collections`

```bash
inflow odp collections list https://compute.example --format json
inflow odp collections search https://compute.example gpu --parent-id hardware --format json
inflow odp collections get https://compute.example hardware --format json
```

Collection list and search return one terse page as `{ service_origin, odp_version, items, next? }`; Collection get
returns `{ service_origin, collection }` containing the full representation. Use `--language` to send `Accept-Language`.
List and search continuations are opaque and can be resumed with `--next`.

### `odp offerings`

```bash
inflow odp offerings capabilities https://compute.example --collection-id gpu --format json
inflow odp offerings list https://compute.example --collection-id gpu --format json
inflow odp offerings search https://compute.example a100 \
  --filter '{"id":"memory","operator":"gte","value":80}' \
  --refinement memory \
  --sort price-lowest \
  --format json
inflow odp offerings get https://compute.example gpu-a100 --format json
inflow odp offerings discover a100 \
  --service-query compute \
  --keyword gpu \
  --payment mpp:inflow \
  --max-services 10 \
  --max-offerings-per-service 5 \
  --format json
```

List and search return one terse page as `{ service_origin, odp_version, items, next?, refinements? }`; get returns
`{ service_origin, offering }`, where `offering` is the SDK's enriched full Offering including resolved Attribute Schema
and normalized Actions when available. Each repeatable `--filter` contains one JSON-encoded ODP filter expression. Use
`capabilities` to resolve Service and Collection filter and sort definitions before constructing those expressions.
Continuations are passed back to the Service SDK unchanged through `--next` and cannot be combined with a new search.

`offerings discover` first selects Services through the canonical directory and then queries each Service's own ODP
catalog. The directory does not hold a global Offering catalog. Without an explicit directory operation filter, the
command derives the required Offering operation from the requested search, Collection, or list behavior. Its structured
result is `{ items }`, with each item containing the matched `service` and `offering`. Service failures are omitted from
this aggregate result; direct per-Service commands remain available when the caller needs a specific failure.

### `odp actions`

```bash
inflow odp actions resolve https://compute.example gpu-a100 purchase --format json
```

`actions resolve` retrieves the full Offering and resolves the selected Action. Direct HTTP Actions return the exact
method and URL plus any resolved request schema. OpenAPI Actions return the identified OpenAPI operation and document.
Resolution is read-only: inspect the returned contract, construct its request body when required, and pass the target to
the existing payment command selected by the live endpoint:

```bash
inflow mpp pay https://compute.example/actions/purchase --method POST --data '{"quantity":1}' --format json
inflow x402 pay https://compute.example/actions/purchase --method POST --data '{"quantity":1}' --format json
```

Those payment commands perform AEP authentication when challenged before continuing through MPP or x402. ODP does not
infer a payment rail from the Offering preview and does not invoke an Action during resolution.

## `aep`

The `aep` group implements six Agent Enrollment Protocol Service commands. `inspect` is stateless and works logged out.
The other commands use the existing InFlow authentication session to authenticate to the InFlow Platform; the
Platform-issued AEP assertion separately authenticates the Agent to the Service.

### Access and credential storage

The CLI stores Service-scoped identities in SQLite and encrypts complete credential material in the local vault. Stored
state belongs to the canonical InFlow Platform origin and authenticated user. Logout clears it. Agent output never
exposes credential secrets: `grant` reports only credential metadata, and `status` reports only usable local grant
summaries.

### `aep inspect`

```bash
inflow aep inspect service.example
inflow aep inspect https://service.example/private --method GET
```

Inspection probes an exact URL when one is supplied and reports `resource_authentication` as `not-required`,
`aep-authenticatable`, or `other-authentication-required`. DID input reports `not-checked`. Service discovery remains
origin-based.

The `resolved` object includes URLs only for commands listed in the Service's `commands.supported` array.

### `aep fetch`

```bash
inflow aep fetch https://service.example/private --format json
```

Fetch preserves the original method, headers, replayable body, redirect and response bounds, and output controls. When
authenticated AEP access reaches a legitimate payment `402`, the command exits successfully with
`payment_required.protocols` and copyable `payment_required.commands` so callers can continue with `mpp pay` or
`x402 pay`; it never creates a payment transaction itself.

### `aep enroll`, `aep status`, `aep grant`, and `aep revoke`

```bash
inflow aep enroll service.example --interval 5
inflow aep status service.example --format json
inflow aep grant service.example --scope read:resource
inflow aep revoke service.example
```

Enroll returns the complete validated Service response. Status returns `{ service, local: { grants } }`; when the Agent
is not enrolled, it returns `{ enrolled: false, service: null, local: { grants: [] } }`. Grant returns `granted`,
credential metadata, and scopes; revoke returns `revoked` and its single selector field.

When enrollment cannot satisfy required claims, the command exits nonzero with `AEP_REQUIREMENTS_UNMET`. Agent output
includes `error.details.reason` as `account_information_missing`, `account_information_invalid`, or
`unsupported_claims`. Missing and invalid account information includes an `update_account` resolution with the
environment-appropriate InFlow account URL and a retry command. Unsupported claims identify the claim names and use a
`service_update_required` resolution because editing the account cannot satisfy them. Personal claim values are never
included in error output.

## `inspect`

The URL selects public document inspection or endpoint probing:

- An origin or `/` path discovers ODP first, then OpenAPI when ODP is absent.
- `/.well-known/odp`, `/.well-known/x402.json`, and paths containing `openapi` (case-insensitive) are inspected as
  documents. An exact-document failure is reported without falling back to an endpoint probe.
- Other paths retain endpoint probing. Explicit `--method`, `--data`, or `--header` selects probing regardless of path,
  including `--method GET`.

Public document inspection requires no login or vault access and invokes no advertised operation. Use `--refresh` to
revalidate documents and rediscover origin candidates. Multiple OpenAPI candidates require an exact URL. For documents
at other paths, use `openapi operations list/get`, which explicitly selects document reading.

```bash
inflow inspect https://demo.inflowpay.ai
inflow inspect https://parallelmpp.dev/openapi.json --refresh
inflow inspect https://seller.example.com/ --method GET
```

Document JSON output contains `outcome: "document-inspected"`, `source: { type, url }`, and `document`. ODP includes
`service_origin` and the validated Service Document. OpenAPI includes `operation_count` and the parsed document with
title, version, operations, server choices, parameters, authentication declarations, and limitations. These declarations
do not prove that an endpoint is free or payable; actual payment challenges are checked only by endpoint probing.
Discovery failures use `SOURCE_NOT_FOUND`, `SOURCE_AMBIGUOUS` (with candidate URLs in its message), or
`SOURCE_UNAVAILABLE`; other document failures use `INSPECT_DOCUMENT_FAILED`. `--refresh` on an endpoint probe returns
`INSPECT_REFRESH_REQUIRES_DOCUMENT`.

### Endpoint probing

```bash
inflow inspect https://seller.example.com/api/widgets
```

Protocol-agnostic, read-only pre-flight. It inspects ODP discovery and decodes AEP, MPP, and x402 requirements without
creating AEP Grant, AEP Sign approval, invoking an ODP Action, or making a payment. The command does not initiate
authentication. When a fresh OpenAPI policy proves AEP authentication is required, `inspect` stops at the AEP gate
unless a compatible stored AEP session credential can reveal the downstream payment layer. Otherwise it probes the URL
once and decodes both MPP and x402 challenges from the same 402 response — so you don't have to know the protocol before
inspecting. This is the recommended first step: read `detected` to decide which rail owns the next action.

Endpoint probing uses `--method`, `--data`, and `--header` and is deliberately unfiltered. For filtered probes or full
per-protocol detail (pay-to, timeout, extras, challenge ids / digests), use [`inflow mpp inspect`](#mpp-inspect) /
[`inflow x402 inspect`](#x402-inspect).

TTY renders a `detected:` summary line, then ODP, AEP, MPP, and x402 sections. Each section shows details or a dim "none
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

Agent shape — fixed-shape arrays (`mpp` / `x402` are `[]` when a protocol is absent). `odp` is `{ available: false }`,
adds `{ error: { code, message } }` for an ODP-scoped failure, or is
`{ available: true, inspect: { document, service_origin } }` when advertised. `detected` lists the protocols that have
at least one entry:

```jsonc
{
  "outcome": "inspected",
  "url": "https://seller.example.com/api/widgets",
  "method": "GET",
  "detected": ["x402"],
  "odp": { "available": false },
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

InFlow treasury payments cannot authorize Permit2. `inspect`, `x402 inspect`, and `x402 pay` exclude `upto` offers and
offers declaring `extra.assetTransferMethod: "permit2"`, including `exact` offers. Explicit filters cannot select these
offers. `x402 decode` preserves the raw header for diagnostics.

If every offer is excluded, inspection explains that InFlow treasury payments cannot authorize the advertised payments.
Structured inspection output includes a `warnings` entry with code `NO_INFLOW_MATCH`; combined inspection also
identifies its protocol as `x402`.

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
and mirrors the x402 payment commands while adding `subscribe` for recurring payments. It uses the same TTY + agent
renderings, the same two-process approval handoff, and the same `--output-file` / `--format` behaviour.

```bash
inflow mpp inspect <url>                                    # parse the seller's Payment challenge(s) — read-only
inflow mpp pay <url> --interval 5 --max-attempts 60         # fast path: create -> poll -> replay -> return body
inflow mpp pay <url> --format json                          # two-process: returns transaction_id + a `mpp fetch` _next hint
inflow mpp subscribe <url> --option-id <optionId> --interval 5 # select terms, approve, and settle period zero
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
  `AEP-Authorization`. Subscription fetches obtain a fresh, short-lived credential for the seller's current challenge;
  no standing subscription credential is stored locally. `status` can still show or save a one-time payment credential
  for diagnostics.
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

## `subscriptions`

Subscription management is protocol-neutral. Activation currently uses `mpp subscribe`; list, get, and cancellation
operate on the resulting subscription independently of the protocol that created it.

```bash
inflow subscriptions list
inflow subscriptions list --status active
inflow subscriptions get <subscriptionId>
inflow subscriptions fetch <subscriptionId> <url>
inflow subscriptions cancel <subscriptionId>
```

List output is buyer-scoped. A participating buyer or seller can retrieve or immediately cancel one subscription.
Subscription fetch requests a short-lived authorization from InFlow and sends it to the seller. The subscription can
therefore be used from any authenticated InFlow CLI installation. Cancellation is idempotent. Failed renewal collection
moves a subscription to `PAST_DUE`; a later successful retry restores `ACTIVE`. Once the subscription end is reached,
`EXPIRED` is terminal. Use `subscriptions get` to see the next scheduled billing attempt.

### Inspection and decoding

`mpp decode --format json` returns `{ "kind": "challenge", "challenge": { ... } }` for one challenge or
`{ "kind": "challenges", "challenges": [{ ... }, { ... }] }` for multiple challenges in one header. Each entry is an
alternative payment option. Credential and receipt inputs use `kind: "credential"` and `kind: "receipt"` respectively.

MPP and x402 inspection can use stored credentials for request signing and AEP access. They start the vault daemon
automatically and prompt terminal users to unlock it. Agent and explicit-format invocations never prompt for a PIN or
passphrase; if required credentials are locked, they return `VAULT_LOCKED` with instructions to run
`inflow vault unlock` in a terminal. Inspection does not initiate a payment or enrollment.

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
