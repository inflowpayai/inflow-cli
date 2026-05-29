# inflow

InFlow — agentic MPP / x402 payments from your machine.

The agent-native and human-accessible command-line entry point to InFlow. Agentic buyers perform agent-native payments
via MPP and x402; humans hit the same functionality from MCP-integrated assistants or the raw CLI.

## Install

```bash
npm install -g @inflowpayai/inflow
```

## Development

This is a pnpm + Turborepo monorepo. Node >= 22 required.

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

## Packages

- `@inflowpayai/inflow` (`packages/cli`) — the published binary. Thin render shell over `inflow-core`.
- `@inflowpayai/inflow-core` (`packages/core`) — the headless InFlow client. One augmented handle per command group
  (`inflow.auth`, `inflow.user`, `inflow.balances`, `inflow.depositAddresses`, `inflow.x402`) carrying both protocol
  primitives and the command-shaped operations, plus the helpers (sanitization, polling, seller-probe) that make both
  work. Workspace-internal today; designed to publish later without internal churn. See
  [`packages/core/README.md`](./packages/core/README.md) for the API tour and
  [`packages/core/examples/`](./packages/core/examples/) for runnable scripts.

## Repository

<https://github.com/inflowpayai/inflow-cli>

## License

MIT — Copyright (c) 2025-2026 Jarwin, Inc.
