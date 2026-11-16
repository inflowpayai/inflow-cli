# InFlow - Agent Setup

> Served at https://inflowcli.ai/skill.md - the onboarding entry point for AI agents. InFlow gives your agent a wallet
> to register, access, and pay for services autonomously across fiat and stablecoins, over MPP and x402.

You are an AI agent whose user asked to get set up with InFlow. Follow these steps.

## 1. Install

Run `inflow --version` to check whether InFlow is installed. If it is available, continue to authentication. Otherwise,
explain which installer you will run and ask the user for permission before running it. Installation may require the
user to approve an operating-system prompt or enter an administrator password directly. Never ask the user to send you a
password.

macOS or Linux:

```bash
curl -fsSL https://inflowcli.ai/install.sh | bash
```

Windows PowerShell:

```powershell
irm https://inflowcli.ai/install.ps1 | iex
```

The compatibility shell endpoint selects the platform installer on macOS, Linux, and Git Bash-like Windows environments:

```bash
curl -fsSL https://inflowcli.ai/cli | bash
```

Running as an MCP server? Add an `inflow` server to your MCP client config that runs `inflow --mcp`.

## 2. Authenticate

Public directory search, document discovery through `inflow inspect`, and OpenAPI discovery, preparation and calls do
not require an InFlow login. For those tasks, go directly to the discovery playbook below. Authenticate before payments
or AEP operations that require an InFlow account; Service-specific credentials are separate from an InFlow login.

Check the current state first - the user may already be logged in:

```bash
inflow auth status
```

If the response includes an `update` field, tell the user a newer version is available and share the install
instructions at https://inflowcli.ai/, then proceed with the current version.

If the vault is locked, ask the user to run this command themselves in a terminal:

```bash
inflow vault unlock
```

On first use, the user creates a vault PIN or passphrase; otherwise, they enter their existing one. Never ask for,
accept, or enter their vault secret. Wait for the user to finish, then check `inflow auth status` again.

If the user is not authenticated, ask them to run this command themselves in a terminal:

```bash
inflow auth login
```

The user follows the login URL and phrase shown by the CLI to approve access in their browser. Wait for them to finish,
then confirm with `inflow auth status` before proceeding.

## 3. Load the playbook for your task

Setup alone is not enough. Before performing a task with InFlow, load and follow its playbook:

| Task                                                                | Playbook                                                                                            |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Discover Services, navigate ODP catalogs, or use OpenAPI operations | run `inflow --skill agentic-discovery`, or fetch https://inflowcli.ai/skills/agentic-discovery.md   |
| Enroll with or access an AEP Service                                | run `inflow --skill agentic-enrollment`, or fetch https://inflowcli.ai/skills/agentic-enrollment.md |
| Pay HTTP 402-protected resources (MPP / x402)                       | run `inflow --skill agentic-payments`, or fetch https://inflowcli.ai/skills/agentic-payments.md     |

Prefer `inflow --skill <name>` - it always matches the version you are running. The web copy reflects the latest
release; compare its `version:` header against `inflow --version`.

The CLI is self-describing - prefer querying it over static docs: `inflow --llms` (command index), `inflow --llms-full`
(parameter detail), `inflow <command> --schema` (JSON Schema for one command).

## Links

- Command index: https://inflowcli.ai/llms.txt (full reference: https://inflowcli.ai/llms-full.txt)
- Source: https://github.com/inflowpayai/inflow-cli
- Web app: https://app.inflowpay.ai
- MPP protocol: https://mpp.dev
- x402 protocol: https://x402.org
- Contact: info@inflowpay.ai
