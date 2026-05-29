# Contributing

Thanks for your interest in `inflow`.

## Development setup

Node >= 22 and pnpm 11.1.3 (managed via `packageManager` and Corepack). Clone the repo and run:

```bash
pnpm install
pnpm build
pnpm test
```

Other tasks:

```bash
pnpm typecheck
pnpm lint
pnpm typedoc
```

## Commit format

Use [Conventional Commits](https://www.conventionalcommits.org/) scoped by package:

```
feat(cli): add `auth login` device flow
fix(core): handle 401 on token refresh
chore: bump turbo to 2.3
```

## Changesets

Any change under `packages/**` requires a changeset. Run:

```bash
pnpm changeset
```

Pick the affected package(s), the bump type (`patch` / `minor` / `major`), and write a short user-facing summary. Commit
the generated file alongside your code. CI fails without one.

`@inflowpayai/inflow-core` is `private` — changesets ignores it; you only need entries for `@inflowpayai/inflow`.

## Pull requests

- Short-lived branches off `main`.
- `pnpm typecheck && pnpm lint && pnpm test && pnpm typedoc` must pass locally before pushing.
- CI runs the same matrix on Node 22 and 24.

## Reporting bugs

File issues at <https://github.com/inflowpayai/inflow-cli/issues>. For security issues, see `SECURITY.md` — do not open
a public issue.
