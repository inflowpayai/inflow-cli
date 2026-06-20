# InFlow Surfaces And Testing

This guide is the per-surface install, smoke-test, and update playbook for every place the `inflow` CLI bundle runs.

It covers the published `@inflowpayai/inflow` npm package, the `agentic-payments` skill, and the CLI-backed MCP server
started with `inflow --mcp` or `npx -y @inflowpayai/inflow --mcp`.

This guide does not cover the separate direct InFlow API MCP server used for account management, policies, approvals,
withdrawals, sellers, and users. That server exposes a different tool set and should be tested from its own API
contract.

## What To Verify

Each skill-aware surface has two artifacts:

- The `agentic-payments` skill, which teaches the agent the payment flow.
- The `inflow` MCP server, which exposes the CLI commands as tools.

MCP-only surfaces have only the MCP server unless you paste the skill body into the host's instructions surface.

Use the CLI as the source of truth for exact commands, flags, schemas, and MCP tools:

```bash
inflow --llms --format json
inflow --llms-full --format json
inflow <command> --schema --format json
```

The current CLI command inventory is:

- `auth login`
- `auth logout`
- `auth status`
- `balances list`
- `deposit-addresses list`
- `inspect`
- `user get`
- `x402 inspect`
- `x402 pay`
- `x402 status`
- `x402 cancel`
- `x402 decode`
- `x402 supported`
- `mpp inspect`
- `mpp pay`
- `mpp status`
- `mpp cancel`
- `mpp decode`
- `mpp supported`

The MCP tool names are derived from those command names by replacing spaces with underscores; hyphens inside command
words are preserved. The current tool inventory is:

- `auth_login`
- `auth_logout`
- `auth_status`
- `balances_list`
- `deposit-addresses_list`
- `inspect`
- `user_get`
- `x402_inspect`
- `x402_pay`
- `x402_status`
- `x402_cancel`
- `x402_decode`
- `x402_supported`
- `mpp_inspect`
- `mpp_pay`
- `mpp_status`
- `mpp_cancel`
- `mpp_decode`
- `mpp_supported`

Call `tools/list` on the MCP server for the authoritative live inventory.

## Shared MCP Config

Use this npx-backed entry when the host accepts JSON MCP configuration:

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

Keep `-y`. Without it, `npx` can wait for install confirmation and the MCP host can report that the server failed to
start.

If the CLI is installed globally and available on the host's `PATH`, this equivalent entry also works:

```json
{
  "mcpServers": {
    "inflow": {
      "command": "inflow",
      "args": ["--mcp"]
    }
  }
}
```

To run against sandbox, add the environment variable if the host supports per-server environment configuration:

```json
{
  "mcpServers": {
    "inflow": {
      "command": "npx",
      "args": ["-y", "@inflowpayai/inflow", "--mcp"],
      "env": {
        "INFLOW_ENVIRONMENT": "sandbox"
      }
    }
  }
}
```

Not every MCP host honors an `env` block. Check the host after installation with `inflow auth status` or the
`auth_status` MCP tool.

## Claude Desktop

Plain Claude Desktop does not run the Claude Code plugin manager, so the skill and MCP are wired separately.

### Install

Install the CLI so the skill body is available:

```bash
npm install -g @inflowpayai/inflow
```

Copy the skill body:

```bash
inflow --skill | pbcopy
```

On Linux, use `wl-copy` or `xclip`; on Windows, use `clip`.

In Claude Desktop, create a project named `InFlow`, open the project instructions, paste the skill body, and save.

Then edit Claude Desktop's MCP config:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

Add or merge the shared `inflow` MCP entry, then fully quit and reopen Claude Desktop.

### Test

Use the `InFlow` project so the pasted skill is in context.

Ask:

```text
Use InFlow to authenticate me.
```

Expected: the agent starts the device flow, shows the verification URL, and polls until authentication completes.

Ask:

```text
Use InFlow to list my balances.
```

Expected: the agent calls `balances_list`. If balances are empty, the skill should lead it to surface deposit addresses.

Ask against a known 402-protected URL:

```text
Use InFlow to inspect and pay https://demo.x402.io/widgets.
```

Expected: the agent detects the protocol, runs the matching read-only inspect step first, then starts the payment flow.

### Update

Refresh the skill body and MCP binary separately:

```bash
npm install -g @inflowpayai/inflow@latest
inflow --skill | pbcopy
```

Paste the refreshed skill body into the Claude project instructions. Restart Claude Desktop so the `npx` MCP entry
resolves the current npm `latest`.

To pin a version, replace `@inflowpayai/inflow` in the MCP args with `@inflowpayai/inflow@<version>`.

## Claude Code And Cowork

Claude Code and Cowork consume the Claude Code plugin bundle. The plugin installs the skill and MCP together.

### Install

From a Claude Code session:

```text
/plugin marketplace add inflowpayai/inflow-cli
/plugin install inflow@inflow-cli
```

If your installed Claude Code CLI supports direct repository installation, this form is equivalent:

```bash
claude plugin install inflowpayai/inflow-cli
```

The marketplace entry points at `plugins/inflow`, whose plugin manifest references `./skills/` and `./.mcp.json`.

### Test

Trigger the skill:

```text
/agentic-payments
```

Expected: the skill loads and the agent responds with the InFlow payment playbook, not generic payment advice.

Ask:

```text
Use InFlow to list the available InFlow MCP tools.
```

Expected: the agent lists the live MCP tools or calls `tools/list` through the host.

Run the skill-driven flow:

```text
Authenticate me with InFlow, then inspect and pay https://demo.x402.io/widgets.
```

Expected: `auth_login` returns a verification URL, polling completes after approval, then the agent runs the matching
inspect and pay tools.

### Update

Reinstall the plugin to refresh the skill body and manifests:

```bash
claude plugin install inflowpayai/inflow-cli --force
```

Restart Claude Code or Cowork so the unpinned `npx` MCP entry resolves npm `latest`.

For pinned MCP installs, edit the local plugin `.mcp.json` and pin `@inflowpayai/inflow@<version>`.

## Codex

Codex consumes the Codex plugin manifest. The plugin installs the skill and MCP together.

### Install

Use Codex's plugin browser and install `inflowpayai/inflow-cli`, or use the CLI when available:

```bash
codex plugin install inflowpayai/inflow-cli
```

The Codex manifest is `.codex-plugin/plugin.json`; it points to `./skills/` and `./.mcp.json`. The per-plugin mirror at
`plugins/inflow/.codex-plugin/plugin.json` has the same shape for hosts that prefer per-plugin discovery.

### Test

Trigger the skill:

```text
/agentic-payments
```

Ask:

```text
Use InFlow to authenticate me, then list my balances.
```

Expected: the skill drives `auth_login` first when needed, then calls `balances_list`.

### Update

Reinstall the plugin:

```bash
codex plugin install inflowpayai/inflow-cli --force
```

Restart Codex so the MCP server resolves npm `latest`. Pin by editing the local `.mcp.json` to
`@inflowpayai/inflow@<version>`.

## OpenClaw

OpenClaw is skill-first. The `agentic-payments` skill frontmatter declares `metadata.openclaw.requires.bins: ["inflow"]`
and an npm install recipe for `@inflowpayai/inflow`.

### Install

From ClawHub, once published:

```bash
openclaw skills install agentic-payments
```

If `inflow` is not on `PATH`, OpenClaw should offer to install the binary with npm.

Before ClawHub publication, install from git if your OpenClaw build supports plugin installs:

```bash
openclaw plugins install git:github.com/inflowpayai/inflow-cli@<tag>
```

### Test

Trigger the skill:

```text
/agentic-payments
```

Ask:

```text
Pay https://demo.x402.io/widgets with InFlow.
```

Expected: the skill drives a read-only protocol check before payment, authenticates if needed, then runs the matching
MCP tools.

### Update

For ClawHub installs:

```bash
openclaw skills update agentic-payments
npm install -g @inflowpayai/inflow@latest
```

For git plugin installs:

```bash
openclaw plugins install git:github.com/inflowpayai/inflow-cli@<new-tag> --force
```

## Hermes

Hermes is MCP-only. It has no native InFlow skill manager, so the MCP server can run without the agent knowing the
payment playbook.

### Install

```bash
hermes mcp add inflow --command npx --args "-y,@inflowpayai/inflow,--mcp"
```

Optionally paste the skill body into Hermes instructions:

```bash
npm install -g @inflowpayai/inflow
inflow --skill | pbcopy
```

### Test

```bash
hermes mcp list
hermes mcp test inflow
```

Expected: Hermes shows the `inflow` server and a live tool list matching `tools/list`.

In a Hermes agent session, ask for an explicit tool call if the skill body was not pasted:

```text
Call the InFlow x402_inspect tool for https://demo.x402.io/widgets.
```

### Update

The npx entry resolves npm `latest` each time the server starts. Pin by editing the args to:

```text
-y,@inflowpayai/inflow@<version>,--mcp
```

## Cursor

Cursor is MCP-only unless you add the skill body to project rules.

### Install

Edit `~/.cursor/mcp.json` or a project-local `.cursor/mcp.json`:

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

Restart Cursor.

Optional skill paste:

```bash
npm install -g @inflowpayai/inflow
mkdir -p .cursor/rules
inflow --skill > .cursor/rules/inflow.md
```

### Test

Open Cursor's MCP tools panel and confirm the `inflow` tools appear. Ask Cursor to call `auth_status` or `x402_inspect`
against a known test URL.

Without the skill body, prompt the agent with explicit tool names and expected ordering. With the skill body, a normal
request such as "authenticate me with InFlow" should follow the playbook.

### Update

Restart Cursor for the npx entry to resolve npm `latest`. Pin by changing the package arg to
`@inflowpayai/inflow@<version>`.

## Cline

Cline is MCP-only unless you paste the skill body into custom instructions.

### Install

Edit Cline's MCP settings file, commonly `~/.cline/cline_mcp_settings.json`:

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

Restart the editor or Cline extension.

Optional skill paste:

```bash
npm install -g @inflowpayai/inflow
inflow --skill | pbcopy
```

Paste into Cline custom instructions.

### Test

Confirm Cline lists the `inflow` MCP server and tools. Ask Cline to call `auth_status`, then `x402_inspect` or
`mpp_inspect` for a known 402-protected URL.

### Update

Restart Cline for npx to resolve npm `latest`. Pin by changing the package arg to `@inflowpayai/inflow@<version>`.

## Continue.dev

Continue.dev is MCP-only unless you paste the skill body into the configured system message.

### Install

Edit `~/.continue/config.json`:

```json
{
  "experimental": {
    "modelContextProtocolServers": [
      {
        "transport": {
          "type": "stdio",
          "command": "npx",
          "args": ["-y", "@inflowpayai/inflow", "--mcp"]
        }
      }
    ]
  }
}
```

Restart the editor or Continue.dev extension.

Optional skill paste:

```bash
npm install -g @inflowpayai/inflow
inflow --skill | pbcopy
```

Paste into Continue.dev's system message.

### Test

Ask Continue.dev to call an `inflow` tool and verify the response. If the skill body is not loaded, ask for explicit
tools such as `auth_status`, `x402_inspect`, or `mpp_inspect`.

### Update

Restart Continue.dev for npx to resolve npm `latest`. Pin by changing the package arg to
`@inflowpayai/inflow@<version>`.

## Raw Stdio MCP

Use this for any MCP-spec-compliant client.

### Install

Use the shared MCP config, or run directly:

```bash
npx -y @inflowpayai/inflow --mcp
```

If the host has a system-prompt or custom-instructions field, paste the skill body:

```bash
npm install -g @inflowpayai/inflow
inflow --skill | pbcopy
```

### Test

Use a full initialize handshake for portable MCP smoke tests:

```bash
{
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
} | npx -y @inflowpayai/inflow --mcp
```

Expected: `initialize` returns `serverInfo.name: "inflow"` and `tools/list` returns the tool array.

The current binary also answers a direct `tools/list` request in the test suite, but the initialize handshake is the
portable check to use across MCP hosts.

### Update

Restart the MCP server to resolve npm `latest`, or pin the package arg to `@inflowpayai/inflow@<version>`.

## Shared Troubleshooting

### npx stalls the MCP host

The MCP host logs show `npx` waiting for package install confirmation.

Fix: keep `-y` in every npx args array:

```json
"args": ["-y", "@inflowpayai/inflow", "--mcp"]
```

### Node version mismatch

The CLI requires Node.js 22 or newer.

Fix:

```bash
nvm install 22 && nvm use 22
```

or use the equivalent command for your Node version manager.

### inflow is not on PATH after global install

Check npm's global bin directory:

```bash
echo "$(npm config get prefix)/bin"
```

Add that directory to `PATH` in the shell config used by the MCP host.

### MCP starts but tools do not appear

Upgrade to the current npm release:

```bash
npm install -g @inflowpayai/inflow@latest
```

Then restart the MCP host and confirm with `tools/list`.

### MCP works but the agent guesses the payment flow

The skill is not loaded. On skill-aware surfaces, reinstall or refresh the plugin. On MCP-only surfaces, paste the skill
body into the host's instruction surface:

```bash
inflow --skill | pbcopy
```

### Skill body drifts from the binary

The CLI-bundled skill is the source of truth for the released binary:

```bash
inflow --skill | head -20
```

Maintainers should sync external skill channels from `skills/agentic-payments/SKILL.md` in this repo and republish the
binary from the same commit.

### Sandbox and production are confused

Check the resolved environment:

```bash
inflow auth status --format json
```

Use `--sandbox`, `--environment sandbox`, or `INFLOW_ENVIRONMENT=sandbox`. For MCP hosts, add an `env` block when the
host supports it.

## Release Verification

Before a release that changes the install footprint, manifests, MCP behavior, or skill content, verify:

- One skill-aware surface: Claude Code, Cowork, Codex, or OpenClaw.
- One MCP-only surface: Cursor, Hermes, or raw stdio MCP.

For each tested surface:

- Confirm the skill loads when the surface supports skills.
- Confirm `tools/list` returns the current MCP tool inventory.
- Confirm `auth_login` reaches a verification URL and polling can complete after approval.
- Confirm `balances_list` or `deposit-addresses_list` returns structured data after authentication.
- Confirm a read-only protocol check with `x402_inspect` or `mpp_inspect`.
- Confirm a full payment flow only against a safe test endpoint and funded test account.

Do not substitute the direct InFlow API MCP test results for this CLI-backed MCP surface. They are different products
with different tool contracts.
