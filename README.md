# inflow

[![CI](https://github.com/inflowpayai/inflow-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/inflowpayai/inflow-cli/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@inflowpayai/inflow)](https://www.npmjs.com/package/@inflowpayai/inflow)
[![npm downloads](https://img.shields.io/npm/dm/@inflowpayai/inflow)](https://www.npmjs.com/package/@inflowpayai/inflow)
[![codecov](https://codecov.io/gh/inflowpayai/inflow-cli/branch/main/graph/badge.svg)](https://codecov.io/gh/inflowpayai/inflow-cli)
[![node](https://img.shields.io/node/v/@inflowpayai/inflow)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Discord](https://img.shields.io/discord/1488618872461332562?logo=discord&logoColor=white&label=Discord)](https://discord.gg/Z9nmMAgaR4)
[![skills.sh](https://skills.sh/b/inflowpayai/inflow-cli)](https://skills.sh/inflowpayai/inflow-cli)

InFlow — Agent Enrollment Protocol access and agentic MPP (Machine Payments Protocol) / x402 payments from your machine.

The agent-native and human-accessible command-line entry point to InFlow. Agentic buyers perform agent-native payments
via MPP and x402, manage Agent Enrollment Protocol Service enrollment, and fetch resources that require AEP
authentication before payment; humans hit the same functionality from MCP-integrated assistants or the raw CLI.

New here? Start with the command reference in [`packages/cli/README.md`](./packages/cli/README.md) — it covers `auth`,
the `x402` and `mpp` command groups, the global flags, and the agent (`--format`) renderings.

Installing into an agent host? Use the per-surface guide:
[`docs/development/surfaces-and-testing.md`](./docs/development/surfaces-and-testing.md).

## Install

InFlow is distributed as a signed native application. The npm package is a compatibility notice and does not run
commands, start MCP, or manage credentials.

Public installation currently targets Apple Silicon and Intel Macs. Windows x64 and ARM64 packages do not build from
pull requests, merges, or package releases; the manual workflow remains available for unsigned validation while
production signing and publication await Microsoft identity approval. Linux ARM64/AMD64 package workflows are validated,
but hosted Linux installation remains unavailable until its signed release assets are published.

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

### macOS hosted installer

```bash
curl -fsSL https://inflowcli.ai/install.sh | bash
```

The installer selects the current Mac architecture, downloads the matching GitHub Release asset and checksum, verifies
the checksum plus macOS code-signing and Gatekeeper checks, installs `InFlow.app` into `~/.local/share/inflow`, and
links `inflow` into `~/.local/bin`.

Run the installer again to upgrade to the latest GitHub Release. Uninstall with:

```bash
curl -fsSL https://inflowcli.ai/install.sh | bash -s -- --uninstall
```

### Direct download

Download the matching zip from the `inflowpayai/inflow-cli` GitHub Release for the package version:

- `inflow-<version>-darwin-arm64.zip` for Apple Silicon Macs
- `inflow-<version>-darwin-x64.zip` for Intel Macs

The zip contains `InFlow.app`; the executable is inside the app bundle at `InFlow.app/Contents/MacOS/inflow`.

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

Upgrade a Homebrew installation with `brew upgrade --cask inflow`. For a hosted installation, rerun the hosted
installer. The CLI may report a newer signed release, but continues unless the API returns `VERSION_UNSUPPORTED`.

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

## macOS release automation

The `native release` workflow creates the version tag and a platform-neutral GitHub Release. Production platform
workflows run from that immutable tag and attach their artifacts independently.

The `macos release` workflow is manually dispatched from GitHub Actions. Its default dry run builds the Apple Silicon
and Intel macOS artifacts, renders the Homebrew Cask, audits the Cask, and uploads workflow artifacts without
notarizing, creating a GitHub Release, or pushing `inflowpayai/homebrew-tap`.

Real release runs require these repository secrets:

- `APPLE_DEVELOPER_ID_APPLICATION_CERTIFICATE_BASE64`
- `APPLE_DEVELOPER_ID_APPLICATION_CERTIFICATE_PASSWORD`
- `APPLE_NOTARY_APPLE_ID`
- `APPLE_NOTARY_APP_SPECIFIC_PASSWORD`
- `APPLE_NOTARY_TEAM_ID`
- `HOMEBREW_TAP_APP_PRIVATE_KEY`

Real release runs also require this repository variable:

- `HOMEBREW_TAP_APP_CLIENT_ID`

The published macOS artifacts are attached to the `inflowpayai/inflow-cli` GitHub Release for the package version, and
the Homebrew Cask in `inflowpayai/homebrew-tap` points at those release assets for Apple Silicon and Intel Macs.

## Linux release automation

The `linux release` workflow builds native AMD64 and ARM64 archives, Debian packages, and RPM packages. Pull requests
use a disposable OpenPGP key to sign a consolidated `SHA256SUMS` release manifest, sign both RPM packages, verify the
result, reject modified metadata and packages, and install through the rendered Linux installer.

Production runs use the protected `linux-production` GitHub environment. That environment permits approval by the
initiating sole release operator, is restricted to release tags, and contains only the exportable automation signing
subkey:

- Environment secret: `LINUX_OPENPGP_SIGNING_SUBKEY_BASE64`
- Environment variable: `LINUX_OPENPGP_SIGNING_FINGERPRINT`

The primary certification key remains offline. It has no expiration. The automation signing subkey has a two-year
lifetime, is reviewed annually, and is replaced approximately 90 days before expiration. The production workflow signs
and verifies the release before uploading versioned assets to the matching GitHub Release.

See [`docs/development/linux-release-signing.md`](./docs/development/linux-release-signing.md) for the offline key
ceremony, GitHub environment setup, release process, and recovery procedure.

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
