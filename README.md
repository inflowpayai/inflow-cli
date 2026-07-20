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

```bash
npm install -g @inflowpayai/inflow
```

Or run directly with `npx`:

```bash
npx @inflowpayai/inflow
```

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
`npx -y @inflowpayai/inflow --mcp`; install the binary globally only for direct CLI use or for hosts configured to run
`inflow --mcp` from `PATH`.

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

The `macos release` workflow is manually dispatched from GitHub Actions. Its default dry run builds the macOS artifact,
renders the Homebrew Cask, audits the Cask, and uploads workflow artifacts without notarizing, creating a GitHub
Release, or pushing `inflowpayai/homebrew-tap`.

Real release runs require these repository secrets:

- `APPLE_DEVELOPER_ID_APPLICATION_CERTIFICATE_BASE64`
- `APPLE_DEVELOPER_ID_APPLICATION_CERTIFICATE_PASSWORD`
- `APPLE_NOTARY_APPLE_ID`
- `APPLE_NOTARY_APP_SPECIFIC_PASSWORD`
- `APPLE_NOTARY_TEAM_ID`
- `HOMEBREW_TAP_APP_PRIVATE_KEY`

Real release runs also require this repository variable:

- `HOMEBREW_TAP_APP_CLIENT_ID`

The published macOS artifact is attached to the `inflowpayai/inflow-cli` GitHub Release for the package version, and the
Homebrew Cask in `inflowpayai/homebrew-tap` points at that release asset.

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
