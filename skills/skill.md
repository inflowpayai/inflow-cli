# InFlow - Agent Setup

> Served at https://inflowcli.ai/skill.md - the onboarding entry point for AI agents. InFlow gives your agent a wallet
> to register, access, and pay for services autonomously across fiat and stablecoins, over MPP and x402.

You are an AI agent whose user asked to get set up with InFlow. Follow these steps.

## 1. Install

Requires Node.js >= 22.

macOS / Linux:

```bash
curl -fsSL https://inflowcli.ai/cli | bash
```

Windows:

```powershell
iwr -useb https://inflowcli.ai/install.ps1 | iex
```

Or install with npm directly: `npm install -g @inflowpayai/inflow`. Or skip installing and run every command through
`npx -y @inflowpayai/inflow`.

Running as an MCP server? Add an `inflow` server to your MCP client config that runs `npx -y @inflowpayai/inflow --mcp`
(keep `-y`; without it the host can stall on first run).

## 2. Authenticate

Check the current state first - the user may already be logged in:

```bash
inflow auth status
```

If the response includes an `update` field, tell the user a newer version is available and how to upgrade
(`npm install -g @inflowpayai/inflow@latest`), then proceed with the current version.

If `authenticated` is `false`, start the OAuth device flow:

```bash
inflow auth login --client-name "<your-agent-name>"
```

Replace `<your-agent-name>` with a clear, unique, identifiable name for your agent - the user sees it on the approval
page in their browser. The response includes a `verification_url` (present it to the user), a `phrase`, and a
`_next.command` - run that command immediately to poll until authenticated; do not wait for the user to respond before
starting the poll. If your environment can't relay the phrase while a polling command blocks I/O, use inline polling
instead:

```bash
inflow auth login --client-name "<name>" --interval 5 --timeout 300
```

Confirm with `inflow auth status` before proceeding.

## 3. Load the playbook for your task

Setup alone is not enough. Before performing a task with InFlow, load and follow its playbook:

| Task                                          | Playbook                                                                       |
| --------------------------------------------- | ------------------------------------------------------------------------------ |
| Pay HTTP 402-protected resources (MPP / x402) | run `inflow --skill`, or fetch https://inflowcli.ai/skills/agentic-payments.md |

Prefer `inflow --skill` - it always matches the version you are running. The web copy reflects the latest release;
compare its `version:` header against `inflow --version`.

The CLI is self-describing - prefer querying it over static docs: `inflow --llms` (command index), `inflow --llms-full`
(parameter detail), `inflow <command> --schema` (JSON Schema for one command).

## Links

- Command index: https://inflowcli.ai/llms.txt (full reference: https://inflowcli.ai/llms-full.txt)
- Source: https://github.com/inflowpayai/inflow-cli
- Web app: https://app.inflowpay.ai
- MPP protocol: https://mpp.dev
- x402 protocol: https://x402.org
- Contact: info@inflowpay.ai
