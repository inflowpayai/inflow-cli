# inflow

[![CI](https://github.com/inflowpayai/inflow-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/inflowpayai/inflow-cli/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@inflowpayai/inflow)](https://www.npmjs.com/package/@inflowpayai/inflow)
[![npm downloads](https://img.shields.io/npm/dm/@inflowpayai/inflow)](https://www.npmjs.com/package/@inflowpayai/inflow)
[![codecov](https://codecov.io/gh/inflowpayai/inflow-cli/branch/main/graph/badge.svg)](https://codecov.io/gh/inflowpayai/inflow-cli)
[![node](https://img.shields.io/node/v/@inflowpayai/inflow)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Discord](https://img.shields.io/discord/1488618872461332562?logo=discord&logoColor=white&label=Discord)](https://discord.gg/Z9nmMAgaR4)
[![skills.sh](https://skills.sh/b/inflowpayai/inflow-cli)](https://skills.sh/inflowpayai/inflow-cli)

InFlow is the command-line client for agentic discovery, onboarding, and payments.

Agents discover Services and Offerings through ODP, establish Service access through AEP, and pay protected endpoints
through MPP or x402. Humans can use the same workflows from MCP-integrated assistants or the InFlow CLI.

New here? Start with the command reference in [`packages/cli/README.md`](./packages/cli/README.md) — it covers `auth`,
ODP discovery, the `x402` and `mpp` command groups, the global flags, and the agent (`--format`) renderings.

Installing into an agent host? Use the per-surface guide:
[`docs/development/surfaces-and-testing.md`](./docs/development/surfaces-and-testing.md).

## Install

InFlow is distributed as a signed native application. The npm package is a compatibility notice and does not run
commands, start MCP, or manage credentials.

Public installation supports Apple Silicon and Intel Macs, Windows x64 and ARM64, and Linux ARM64 and AMD64. Homebrew,
the hosted installers, WinGet, and direct GitHub Release downloads install the signed native application for each
platform.

### Homebrew Cask

```bash
brew tap inflowpayai/tap
brew install --cask inflow
inflow --version
```

Upgrade or uninstall through Homebrew:

```bash
brew upgrade --cask inflow
brew uninstall --cask inflow
```

### Hosted installers

On macOS, Debian/Ubuntu, and Fedora/RHEL:

```bash
curl -fsSL https://inflowcli.ai/install.sh | bash
```

On macOS, the installer selects the current architecture, verifies the checksum plus code-signing and Gatekeeper checks,
installs `InFlow.app` into `~/.local/share/inflow`, and links `inflow` into `~/.local/bin`. On Linux, it verifies the
OpenPGP-signed release manifest and package checksum before installing the matching Debian or RPM system package.

Run the installer again to upgrade to the latest GitHub Release. Uninstall with:

```bash
curl -fsSL https://inflowcli.ai/install.sh | bash -s -- --uninstall
```

On Windows, run PowerShell as a user who can approve the Windows Installer elevation prompt:

```powershell
irm https://inflowcli.ai/install.ps1 | iex
```

The PowerShell installer selects x64 or ARM64, verifies the MSI checksum, Authenticode status, and publisher, and then
installs the package through Windows Installer. Run it again to upgrade. To uninstall while preserving encrypted vault
data:

```powershell
$env:INFLOW_UNINSTALL = '1'
try { irm https://inflowcli.ai/install.ps1 | iex } finally { Remove-Item Env:INFLOW_UNINSTALL }
```

The compatibility shell endpoint delegates to the platform installer on macOS, Linux, and Git Bash-like Windows
environments:

```bash
curl -fsSL https://inflowcli.ai/cli | bash
```

### WinGet

```powershell
winget install --id InFlowPayAI.InFlow --exact
```

Upgrade or uninstall through WinGet:

```powershell
winget upgrade --id InFlowPayAI.InFlow --exact
winget uninstall --id InFlowPayAI.InFlow --exact
```

### Direct download

Download the matching artifact from the `inflowpayai/inflow-cli` GitHub Release for the package version:

- `inflow-<version>-darwin-arm64.zip` for Apple Silicon Macs
- `inflow-<version>-darwin-x64.zip` for Intel Macs
- `inflow-<version>-windows-arm64.msi` for Windows ARM64
- `inflow-<version>-windows-x64.msi` for Windows x64

The zip contains `InFlow.app`; the executable is inside the app bundle at `InFlow.app/Contents/MacOS/inflow`.

Linux releases include ARM64 and AMD64 Debian packages, RPM packages, and standalone archives. Debian and RPM packages
install the system vault service required by the Linux security model.

Windows MSI packages install the command-line application and its on-demand vault service. Windows verifies the
Authenticode signature and publisher before installation.

### Initialize the credential vault

Credential-bearing commands use the encrypted local InFlow vault. Initialize or unlock it in a human-controlled
terminal:

```bash
inflow vault unlock
```

The PIN or passphrase is read only from the terminal. It is not an MCP argument, command-line flag, environment
variable, or structured agent input. `inflow vault status`, `inflow vault lock`, and `inflow vault policy` do not
require the unlock factor.

### Use with agents

Install the `agentic-enrollment` and `agentic-payments` skills into a skills-aware agent:

```bash
npx skills add inflowpayai/inflow-cli
```

The repo also ships as an installable plugin (skill + MCP server bundled) for plugin-aware hosts:

- **Claude Code** — add the marketplace, then install the plugin:

  ```
  /plugin marketplace add inflowpayai/inflow-cli
  /plugin install inflow@inflow
  ```

  Here `inflowpayai/inflow-cli` is the GitHub repo slug; the marketplace, plugin, and binary are all named `inflow`, so
  the install target is `inflow@inflow`.

- **Cursor / Codex** — point the host at this repo; it discovers `.cursor-plugin/marketplace.json`,
  `.agents/plugins/marketplace.json`, and `.codex-plugin/plugin.json` respectively.

In every case the plugin bundles the skill and the `inflow` MCP server (`.mcp.json`). The default MCP entry runs
`inflow --mcp`; install the signed native binary before using the MCP server.

## Security and local data

- OAuth tokens, API keys, and Agent Enrollment Protocol credentials are encrypted in the local SQLite vault.
- The vault daemon accepts only authenticated local InFlow clients and exposes exact-reference secret operations, not
  payment, network, signing, or command-execution operations.
- The daemon authenticates clients, and clients authenticate the daemon before transmitting requests.
- Vault unlock factors are entered only in a human terminal. Agent and MCP executions fail closed while the vault is
  locked.
- macOS uses the signed application identity. Windows uses Authenticode-signed application and Windows service
  identities. Linux packages install a system service and enforce executable, socket, peer, tenant, and package identity
  checks.
- `inflow auth logout` and `inflow vault reset` remove local credentials and vault state. Package uninstall preserves
  encrypted vault data unless the platform-specific purge operation is requested.

InFlow sends authenticated API requests, seller-resource requests requested by the user, and an advisory GitHub Release
version check. Set `NO_UPDATE_NOTIFIER=1` to disable the version check. The check has a two-second deadline and does not
send credentials.

## Upgrade and troubleshooting

Upgrade a Homebrew installation with `brew upgrade --cask inflow`, a WinGet installation with
`winget upgrade --id InFlowPayAI.InFlow --exact`, or a hosted installation by rerunning its platform installer. The CLI
may report a newer signed release, but continues unless the API returns `VERSION_UNSUPPORTED`.

If an agent or MCP tool reports that the vault is locked, run `inflow vault unlock` yourself in a terminal and retry the
operation. Never paste the PIN or passphrase into a prompt or MCP tool input.

Use `inflow auth status --format json` to check authentication and environment state, and `inflow vault status` to check
the local vault and daemon. See the [surface install and testing guide](./docs/development/surfaces-and-testing.md) for
host-specific MCP troubleshooting.

## Development

This is a pnpm + Turborepo monorepo. Node >= 24.15.0 required.

```bash
pnpm install
pnpm build
pnpm test
```

Other useful tasks:

```bash
pnpm typecheck
pnpm lint
pnpm typedoc
pnpm changeset
```

## Release automation

Production releases use one atomic native workflow that signs and verifies the macOS, Windows, and Linux artifacts
before publishing an immutable GitHub Release and updating the platform distribution channels. See the
[native release guide](./docs/development/native-release.md) for workflow modes, platform credentials, signing order,
and recovery procedures.

## Packages

- `@inflowpayai/inflow` (`packages/cli`) — the published binary, and the entry point for anyone integrating InFlow. Thin
  render shell over `inflow-core`. See [`packages/cli/README.md`](./packages/cli/README.md) for the full command
  reference.
- `@inflowpayai/inflow-core` (`packages/core`) — the headless InFlow client behind the binary. One augmented handle per
  command group (`inflow.auth`, `inflow.user`, `inflow.balances`, `inflow.depositAddresses`, `inflow.x402`,
  `inflow.mpp`) carrying both protocol primitives and the command-shaped operations, plus the helpers (sanitization,
  polling, seller-probe) that make both work. Workspace-internal today; see
  [`packages/core/examples/`](./packages/core/examples/) for runnable scripts.

## Repository

<https://github.com/inflowpayai/inflow-cli>

## License

MIT — Copyright (c) 2025-2026 Jarwin, Inc.
