# InFlow Surfaces And Testing

This guide covers installation and smoke testing for the signed native `inflow` command-line application, its bundled
skills, and its local MCP server. The npm package is a compatibility notice and cannot run commands, start MCP, or
manage credentials.

This guide does not cover the separate direct InFlow API MCP server used for account management, policies, approvals,
withdrawals, sellers, and users.

## Install the native application

Install InFlow before configuring an agent host. Public installation currently supports Apple Silicon and Intel macOS
through Homebrew:

```bash
brew tap inflowpayai/tap
brew install --cask inflow
```

The hosted shell installer supports macOS, Debian/Ubuntu, and Fedora/RHEL:

```bash
curl -fsSL https://inflowcli.ai/install.sh | bash
```

On Windows PowerShell:

```powershell
irm https://inflowcli.ai/install.ps1 | iex
```

On macOS, Linux, or a Git Bash-like Windows environment, the compatibility endpoint delegates to the appropriate
platform installer:

```bash
curl -fsSL https://inflowcli.ai/cli | bash
```

Windows users can also install through WinGet:

```powershell
winget install --id InFlowPayAI.InFlow --exact
```

Signed Linux ARM64 and AMD64 Debian packages, RPM packages, and standalone archives are published through GitHub
Releases. Signed Windows x64 and ARM64 MSI packages install the command-line application and on-demand vault service.
For release-operator setup, see the [native release guide](./native-release.md).

The Windows MSI installs `inflow.exe` under `%ProgramFiles%\InFlow`, adds that directory to the system `PATH`, and
registers the demand-start `InFlowVault` service as `NT SERVICE\InFlowVault`. Per-user encrypted vaults live under
`%ProgramData%\InFlow\vaults`; uninstall preserves that directory.

Verify the installed executable:

```bash
inflow --version
inflow auth status --format json
inflow vault status
```

## Credential vault boundary

OAuth tokens, API keys, and Agent Enrollment Protocol credentials are encrypted in the local InFlow vault. Initialize or
unlock it from a human-controlled terminal:

```bash
inflow vault unlock
```

Do not put the PIN or passphrase in an agent prompt, MCP input, command-line flag, environment variable, or redirected
standard input. The structured CLI and MCP server deliberately expose no unlock-factor field. When the vault is locked,
the agent receives a human-action error; unlock it manually and retry the original request.

Useful lifecycle commands:

```bash
inflow vault status
inflow vault policy
inflow vault lock
inflow vault change-passphrase
inflow vault reset
```

`inflow auth logout` removes local authentication and vault state after attempting eligible remote cleanup. Application
uninstall preserves encrypted vault data. Use the platform-specific purge operation only when the data must also be
removed.

## Shared MCP configuration

The signed binary contains the CLI, MCP, and daemon entry points. Configure every host to execute that installed binary:

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

If a graphical host does not inherit the shell `PATH`, use the absolute path returned by:

```bash
command -v inflow
```

To use the sandbox environment in a host that supports per-server environment variables:

```json
{
  "mcpServers": {
    "inflow": {
      "command": "inflow",
      "args": ["--mcp"],
      "env": {
        "INFLOW_ENVIRONMENT": "sandbox"
      }
    }
  }
}
```

Do not replace `inflow` with `npx`, Node, a repository checkout, or a copied JavaScript bundle. Those paths do not carry
the installed application identity required by the vault boundary.

## Skills and plugins

The repository contains the `agentic-enrollment` and `agentic-payments` skills. A skills-aware host can install them
with:

```bash
npx skills add inflowpayai/inflow-cli
```

The repository also contains Claude Code, Cursor, Codex, and generic agent plugin manifests. Each plugin points its MCP
entry at `inflow --mcp`; the signed native application must already be installed on the host.

For an MCP-only host, print a bundled skill body and paste it into that host's instructions:

```bash
inflow --skill
inflow --skill agentic-enrollment
```

On macOS, `inflow --skill | pbcopy` copies the default payment playbook. Use `wl-copy` or `xclip` on Linux and `clip` on
Windows.

## Claude Desktop

Plain Claude Desktop does not use the Claude Code plugin manager. Paste the desired skill into project instructions,
then add the shared MCP configuration to:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

Fully quit and reopen Claude Desktop. Confirm the MCP server starts, then ask it to call `auth_status`.

## Claude Code and local Cowork

Install the plugin from a Claude Code session:

```text
/plugin marketplace add inflowpayai/inflow-cli
/plugin install inflow@inflow
```

The plugin installs the skill and MCP manifest together. Local Cowork launches the MCP server on the host; do not copy
the binary, vault database, or credentials into its Linux guest. Remote Cowork cannot use a local MCP server unless the
product provides an explicit host bridge.

After plugin installation, trigger `/agentic-payments` and ask the host to list InFlow MCP tools. Unlock the vault in a
separate host terminal before testing a credential-bearing tool.

## Codex and Cursor

Install the repository plugin through the host's plugin browser. Codex discovers `.codex-plugin/plugin.json`; Cursor
discovers `.cursor-plugin/marketplace.json`. Both ultimately execute the shared `inflow --mcp` entry.

For a manual Cursor setup, place the shared MCP configuration in `~/.cursor/mcp.json` or `.cursor/mcp.json`, restart
Cursor, and confirm the tools panel shows InFlow.

## Hermes, Cline, Continue.dev, and raw MCP

These hosts can use the shared MCP configuration if they accept a standard-input/output MCP server. Use the exact
configuration shape required by the host, with `command` set to the installed `inflow` path and arguments set to
`["--mcp"]`.

For a raw protocol smoke test:

```bash
{
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
} | inflow --mcp
```

Expected: initialization reports `serverInfo.name` as `inflow`, and `tools/list` returns the installed tool inventory.

## What to test

The live CLI is the source of truth for commands, schemas, and MCP tools:

```bash
inflow --llms --format json
inflow --llms-full --format json
inflow <command> --schema --format json
```

For each agent host:

1. Confirm the installed executable reports the expected version.
2. Confirm the skill loads when the host supports skills.
3. Confirm MCP `tools/list` returns the current inventory.
4. Confirm `auth_status` reports locked state without exposing secrets when the vault is locked.
5. Unlock the vault manually and confirm `auth_login` reaches a verification URL.
6. Confirm `balances_list` or `deposit-addresses_list` returns structured data after authentication.
7. Confirm a read-only `x402_inspect` or `mpp_inspect` call.
8. Run a payment only against an approved test endpoint and funded test account.

Do not use direct InFlow API MCP results as evidence for this local CLI-backed MCP surface.

## Upgrade

For Homebrew:

```bash
brew upgrade --cask inflow
```

For a hosted installation, rerun the hosted installer. Reinstall or refresh the plugin separately when its skill or
manifest changes, then restart the host.

For WinGet:

```powershell
winget upgrade --id InFlowPayAI.InFlow --exact
```

The CLI checks the latest GitHub Release with a two-second deadline. Human executions may print an advisory update
notice. `auth status` structured output may include `current_version` and `latest_version`. An advisory does not block
the current command; `VERSION_UNSUPPORTED` means the upgrade is mandatory. Set `NO_UPDATE_NOTIFIER=1` to disable the
advisory check.

Upgrades preserve the encrypted vault but leave it locked after daemon replacement. Unlock it manually before the next
credential-bearing request.

## Uninstall and purge

Homebrew uninstall:

```bash
brew uninstall --cask inflow
```

Hosted macOS uninstall:

```bash
curl -fsSL https://inflowcli.ai/install.sh | bash -s -- --uninstall
```

Hosted Windows uninstall:

```powershell
$env:INFLOW_UNINSTALL = '1'
try { irm https://inflowcli.ai/install.ps1 | iex } finally { Remove-Item Env:INFLOW_UNINSTALL }
```

WinGet uninstall:

```powershell
winget uninstall --id InFlowPayAI.InFlow --exact
```

Windows Installer and Linux package uninstall preserve encrypted vault data. Linux `install.sh --purge` removes the
package and system vault data. `inflow vault reset` is the cross-platform command for intentionally removing local vault
state before uninstall.

## Troubleshooting

### MCP process does not start

On macOS or Linux, run `command -v inflow` in the same environment as the host. If the graphical host has a different
`PATH`, configure the absolute path. Run `inflow --mcp` in a terminal and inspect the host's MCP logs.

On Windows, restart the terminal and graphical host after installation so they inherit the updated system `PATH`. If
needed, configure the MCP command with the resolved full path, such as `C:\Program Files\InFlow\inflow.exe`, and inspect
the service with:

```powershell
Get-Command inflow
Get-Service InFlowVault
```

### MCP tools are present but credential operations fail

Run:

```bash
inflow vault status
inflow auth status --format json
```

If the vault is locked, run `inflow vault unlock` in a human terminal. Do not add the factor to MCP configuration.

### The agent guesses the payment flow

The skill is missing. Refresh the plugin on skill-aware hosts, or paste the output of `inflow --skill` into the host's
instructions.

### Environment is wrong

Check `inflow auth status --format json`. Use `--sandbox`, `--environment sandbox`, or `INFLOW_ENVIRONMENT=sandbox`. Add
an `env` block only when the MCP host supports it.

### A custom legacy credential file remains

The signed application deletes the standard legacy plaintext configuration and any path explicitly supplied through
`--auth` or `INFLOW_AUTH_FILE`. It cannot discover arbitrary paths that are no longer supplied. If an older installation
used a custom path, remove that file manually after confirming the signed application is using the encrypted vault. Do
not pass the legacy file to another application or attempt to import it into the vault.

### Installed binary appears modified or mismatched

Reinstall through the signed platform channel. Do not copy an executable between installations or invoke a development
bundle as a substitute. On macOS, verify with `codesign --verify --deep --strict`; on Windows, inspect the Authenticode
signature; on Linux, reinstall through the signed package or repository once the production repository is published.

```powershell
Get-AuthenticodeSignature "$env:ProgramFiles\InFlow\inflow.exe"
```

## Privacy and security checks

- Confirm command and MCP output never contains access tokens, refresh tokens, API keys, credentials, or unlock factors.
- Confirm agent and MCP schemas have no PIN, passphrase, password, secret, or raw authorization input.
- Confirm locked and unavailable vault states fail closed.
- Confirm the MCP host launches the installed signed binary, not npm or a development checkout.
- Confirm update checks contain no credentials and can be disabled with `NO_UPDATE_NOTIFIER=1`.
- Confirm reset, logout, uninstall, and purge behavior matches the user's intended data-retention choice.
