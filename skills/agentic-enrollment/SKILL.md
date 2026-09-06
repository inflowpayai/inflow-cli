---
version: 0.12.2
name: agentic-enrollment
description: Inspect, enroll with, authenticate to, and manage credentials for Agent Enrollment Protocol Services through InFlow. Use when an agent needs to discover an AEP Service, access an AEP-protected resource, check enrollment, request or revoke Service credentials, or continue an InFlow approval.
allowed-tools: ['Bash(inflow:*)', 'Bash(brew:*)', 'Bash(curl:*)']
user-invocable: true
license: MIT
metadata: { "author": "Jarwin, Inc.", "url": "inflowcli.ai", "openclaw": { "homepage": "https://inflowcli.ai", "requires": { "bins": ["inflow"] }, "install": [{ "id": "homebrew-cask", "kind": "homebrew", "tap": "inflowpayai/tap", "cask": "inflow", "bins": ["inflow"], "label": "Install InFlow with Homebrew" }, { "id": "hosted-shell", "kind": "shell", "url": "https://inflowcli.ai/install.sh", "bins": ["inflow"], "label": "Install InFlow with the hosted installer" }] } }
---

# Agentic Enrollment

Discover Agent Enrollment Protocol Services, enroll an Agent, manage Service credentials, and retrieve protected
resources. Let the CLI own protocol discovery, signing, approvals, credential storage, expiration, and authenticated
replay. Do not construct AEP assertions or authentication headers yourself.

## Setup

Install the signed native CLI through one of these channels:

| Channel | Command |
| --- | --- |
| macOS Homebrew | `brew tap inflowpayai/tap && brew install --cask inflow` |
| macOS/Linux hosted installer | `curl -fsSL https://inflowcli.ai/install.sh \| bash` |
| Windows PowerShell installer | `irm https://inflowcli.ai/install.ps1 \| iex` |
| Cross-platform shell compatibility | `curl -fsSL https://inflowcli.ai/cli \| bash` |

Current install instructions live at https://inflowcli.ai/.

InFlow runs as a standalone CLI or an MCP server. MCP exposes each CLI command as a tool with underscores replacing
spaces, such as `aep_fetch`. Call `tools/list` for the authoritative inventory.

Use structured output when acting programmatically:

```bash
inflow aep <command> ... --format json
```

Credential-bearing commands require the encrypted local vault. If the CLI reports that the vault is uninitialized or
locked, tell the user to run `inflow vault unlock` themselves in a terminal, then retry. Never ask for or accept the
vault PIN or passphrase through chat, an MCP tool, a command-line flag, or an environment variable.

Use `inflow aep <command> --schema` for exact arguments and flags. Use `inflow --llms-full` for the complete command
reference.

## Choose the command

| Goal | Command |
| --- | --- |
| Detect AEP alongside MPP and x402 for an exact resource | `inflow inspect <resource-url>` |
| Inspect one AEP Service or resource | `inflow aep inspect <service-or-resource>` |
| Retrieve a resource anonymously or with AEP authentication | `inflow aep fetch <resource-url>` |
| Establish Service enrollment | `inflow aep enroll <service-or-resource>` |
| Check enrollment and non-secret local credentials | `inflow aep status <service-or-resource>` |
| Request and store a Service credential explicitly | `inflow aep grant <service-or-resource>` |
| Revoke Service credentials | `inflow aep revoke <service-or-resource>` |

`fetch` is the resource-access workflow. Use the lifecycle commands only for their named purpose; they do not produce
credentials that can be copied into a protected-resource request.

## Inspect before acting

For an exact resource URL, start with the combined inspection command when you do not already know which protocol is in
use:

```bash
inflow inspect https://service.example/api/resource --format json
```

If `detected` includes `aep`, use `aep fetch`. A resource that returns successfully without authentication is not an
error; return its content without enrolling or requesting approval.

Use AEP-specific inspection for Service discovery and resource authentication details:

```bash
inflow aep inspect https://service.example/api/resource --format json
```

Inspection is unauthenticated. It accepts a DID, hostname, origin, or full resource URL. Query parameters do not define
the resource authentication policy. The Service's OpenAPI metadata may provide the exact operation policy; otherwise
the CLI uses the live authentication challenge. Do not infer support from a failed or unrelated endpoint.

If inspection reports `service_identity_mismatch`, stop. Do not enroll, request an assertion, or send credentials to
that Service. Directory membership does not override this failure.

## Fetch a resource

Prefer `fetch` for normal resource access:

```bash
inflow aep fetch https://service.example/api/resource --format json
```

The command performs one logical operation through anonymous access, stored-credential selection, Grant when needed,
InFlow approval, and authenticated replay. Keep the invocation alive while approval is pending. Do not start a second
fetch or Grant to continue the same request.

If authenticated access reaches a payment `402`, `aep fetch` returns a successful `payment_required` frame with the
matching `mpp pay` or `x402 pay` command. Switch to `inflow --skill agentic-payments` for the payment step instead of
retrying AEP authentication.

For non-GET resources, preserve the caller's request:

```bash
inflow aep fetch https://service.example/api/widgets \
  --method POST \
  --data '{"sku":"widget-1"}' \
  --header 'X-Request-ID: request-1' \
  --format json
```

Use `--grant-type` or `--credential-id` only when the caller needs a specific advertised method or stored credential.
Otherwise the CLI selects a usable credential or the first compatible advertised method. Expired credentials are
removed and never selected.

Use `--output-file <path> --no-show-body` for binary or sensitive response bodies. The JSON result reports the requested
and final URLs, response status and size, authentication outcome, non-secret credential metadata, and either an inline
body or `output_saved_to`.

## Enroll and check status

An InFlow login is required before enrollment or an operation that needs the user's permission:

```bash
inflow auth status --format json
inflow auth login --client-name '<agent-name>' --interval 5 --timeout 300 --format json
```

Enroll once per Service:

```bash
inflow aep enroll service.example --interval 5 --timeout 900 --format json
```

The CLI presents the InFlow approval and polls it inside the same invocation. A declined approval, cancellation, or
timeout is terminal for that enrollment attempt. Do not resume or reuse an interrupted enrollment; start a new Enroll
only when the user asks again. Existing enrollment is detected and must not create a duplicate registration.

Check current state without treating missing enrollment as a hard failure:

```bash
inflow aep status service.example --format json
```

Status reports the Service lifecycle state plus non-secret summaries of usable local credentials. It does not reveal
credential values.

## Request or revoke credentials

Use explicit Grant when the task is credential management rather than immediate resource access:

```bash
inflow aep grant service.example --grant-type api-key --scope read:resource --interval 5 --timeout 900 --format json
```

Grant requires an existing enrollment. Missing enrollment is a normal state: enroll first only with the user's intent.
Grant stores the returned secret locally and reports non-secret metadata. `fetch` can request Grant automatically when
accessing a resource and no usable credential exists.

Without a selector, Revoke invalidates every Service credential:

```bash
inflow aep revoke service.example --format json
```

Narrow revocation only when requested:

```bash
inflow aep revoke service.example --grant-type oauth-bearer --format json
inflow aep revoke service.example --credential-id credential-123 --format json
```

## User approval

An approval is an asynchronous request for the user to authorize an Agent action. InFlow may notify the user through
their configured channels, such as the mobile app or email, and the CLI can present a dashboard link where they can
approve or decline. The CLI waits for that decision and continues the original command after approval.

Enrollment, credential issuance, and protected-resource authentication may require approval. Status checks and
credential revocation do not prompt the user for approval.

When an approval is pending:

- Present the approval URL when returned and keep polling in the original command.
- On decline, report the decline and stop.
- On interruption, allow the CLI to cancel its wait; do not create a replacement request automatically.
- On timeout, ask whether the user wants to try a new operation.
- Never expose signed authentication material, API keys, bearer tokens, Basic credentials, or internal approval data in
  chat.

InFlow account logout clears user-owned AEP identities and credentials. Public discovery documents are cached
separately and contain no user credentials.
