# AGENTS.md

Operating notes for working in this repo. If anything below conflicts with the configs (`eslint.config.js`,
`typedoc.json`, `tsconfig.base.json`, `turbo.json`, `.changeset/config.json`, `.prettierrc.json`), the configs win — fix
the drift, don't paper over it.

## What this repo is

`inflow` is the agent-native and human-accessible command-line entry point to InFlow. It lets agentic buyers perform
agent-native payments via MPP and x402, and lets humans hit the same functionality from MCP-integrated assistants or the
raw CLI.

A pnpm + Turborepo monorepo with two packages:

- `@inflowpayai/inflow-core` (`packages/core`) — the headless InFlow client. One augmented handle per command group hung
  off the `Inflow` instance: `inflow.auth` (IAuth), `inflow.user` (IUser), `inflow.balances` (IBalanceResource),
  `inflow.depositAddresses` (IDepositAddressResource), `inflow.x402` (IX402). Each handle carries the typed HTTP
  primitives plus the command-shaped operations (reducers + async-iterable drivers for the stateful commands). No UI
  dependencies; an ESLint `no-restricted-imports` rule scoped to `packages/core/src/**` enforces this.
- `@inflowpayai/inflow` (`packages/cli`) — the published binary. Consumes the core package; renders Ink/React for TTY
  mode and structured output for agent mode. The CLI commands are thin render shells over the core flows.

## Repo map

- `packages/cli/` — `@inflowpayai/inflow`, the published binary.
- `packages/core/` — `@inflowpayai/inflow-core`, the typed HTTP client.
- `plugins/inflow/` — the plugin bundle: `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`.
- `skills/agentic-payments/SKILL.md` — the single skill file.
- `.claude-plugin/marketplace.json` — Claude Code marketplace entry.
- `.codex-plugin/plugin.json` — Codex marketplace entry.
- `.mcp.json` — raw MCP entry.
- `scripts/` — repo-level dev/CI scripts.
- `.changeset/` — pending version bumps.

Load-bearing root files — touch with care: `tsconfig.base.json`, `turbo.json`, `eslint.config.js`,
`.changeset/config.json`, `typedoc.json`, `.prettierrc.json`, `pnpm-workspace.yaml`.

## Before merging

Run all four. CI runs the same.

- `pnpm typecheck` — `tsc --noEmit` against both `tsconfig.json` (src) and `tsconfig.test.json` (src + test) per
  package.
- `pnpm lint` — eslint with `--max-warnings 0`.
- `pnpm test` — vitest with v8 coverage; per-package thresholds enforced; build fails below floor.
- `pnpm typedoc` — generates the core package's public API reference; catches broken `{@link}` and internal-type leakage
  into public signatures. Runs against `@inflowpayai/inflow-core` only; the binary has no public API.

Scope to one package with `pnpm --filter @inflowpayai/<name> <task>`.

The CLI's integration tests run against the built `packages/cli/dist/cli.js`. Run `pnpm build` before running them if
source has changed.

## Conventions

Rules the tooling can't enforce. Breaking them lands a regression.

- **ESM everywhere.** `"type": "module"` in every `package.json`. No CJS.
- **Node ≥ 22.0.0.** `engines.node` enforces. CI matrix tests 22 + 24. `.node-version` pinned to 22.
- **TypeScript strict mode.** Shared `tsconfig.base.json`. `noUncheckedIndexedAccess` is on.
- **No `any`, no `!` non-null, no `as unknown as`** except at documented type boundaries. Justify and comment every
  boundary cast.
- **No `console.*` in `packages/**/src/**`.** Publishable code throws typed errors and lets the caller decide what to
  log. `process.stderr.write` is the only exception, and only inside the CLI's top-level entry. `console.*` is fine in
  `scripts/` and `test/`.
- **The package barrel is the public surface.** Anything in `src/index.ts` is public API; anything else is
  implementation detail. Add `@internal` for exported-but-not-public symbols.
- **No emoji** in code, commits, or PR descriptions unless the request explicitly calls for them.
- **No "future work" / "phase 2" / "TODO: refactor later" comments.** Describe what the code does now, or delete the
  comment. Out-of-scope work becomes a separate change, not a stub.
- **Comments only for what the code can't say.** No restatement of behavior, no rationale-padding, no historical
  justification. Applies to every comment syntax — TSDoc, inline, YAML, shell, JSON-with-comments.
- **Minimal TSDoc.** This is a CLI, not a public-facing library. The README carries the long-form context. Default to
  **no TSDoc** unless the signature genuinely can't say it. The signature names parameters, the type names them, the
  function name names them — if you find yourself paraphrasing those, delete the comment.
- **Output formats are part of the contract.** Every command's `--format json` shape is specified to the field level.
  Don't drift the shape without bumping the changeset.
- **Two modes per command.** Interactive (Ink, TTY) and agent (`--format` set or non-TTY). Gate via the framework's
  `agent`/`formatExplicit` flags. Agent mode never renders Ink.
- **ANSI sanitization is non-negotiable.** All core-package responses pass through a recursive sanitizer via a
  resource-wrapping Proxy before reaching the renderer or the formatter. Don't add a resource that bypasses the Proxy.
- **Credential files are `0o600`.** Use `conf` for the auth file. Use `0o600` and `--force`-gated overwrite for any
  other file the CLI writes that contains a credential.
- **Schemas drive flags AND MCP tool input.** One `zod` schema per command, colocated with the command. The framework
  registers CLI flags from the schema; the same schema is the MCP tool input schema.
- **Behaviors are designed up front, per command.** State-mutating commands (login, logout, pay, cancel, retry) document
  the failure mode of every step, both TTY and agent modes, the `--format json` output shape, and the exact error
  `code`/`message` strings. Retrofit-style behavior design is a regression.

## Adding a package

For a new package: follow the structure of the existing packages — `packages/<name>/{src,test/unit}`, `package.json`
with the standard fields (`peerDependencies` if needed, `publishConfig.access: public`,
`publishConfig.provenance: true`), `tsconfig.json` + `tsconfig.test.json`, `tsup.config.ts`, `vitest.config.ts`,
`README.md`. Then `pnpm install` to refresh the lockfile.

New packages should be rare. If you're adding one, the change should justify why a new package boundary is needed
instead of a new module inside `packages/cli` or `packages/core`.

## Writing docs

- **The README is the long-form doc.** It carries usage examples, integration recipes, and the conceptual map. Keep it
  accurate; the published `README.md` ships in the npm package.
- **TSDoc is minimal.** Default to none. Add a TSDoc block only when the signature can't say it and there's a
  non-obvious sentence the caller needs. The linter does not require TSDoc on every export.
- **Use `{@link Foo}` only for symbols re-exported from the package barrel** — links must resolve from the published API
  reference.
- **`@internal` for symbols not re-exported** from the barrel.
- **Skills live in `skills/agentic-payments/SKILL.md`.** YAML frontmatter is single-line (the embedded agent parser is
  line-based — multi-line frontmatter values break it).

## Branch model, commits, releases

- Short-lived branches off `main`. Conventional Commits, scoped by package: `feat(cli): …`, `fix(sdk): …`.
- PRs touching `packages/**` need a Changeset (`pnpm changeset`). CI fails without one.
- Release flow uses `changesets/action` from `.github/workflows/release.yml`. Only `@inflowpayai/inflow` publishes to
  npm — `@inflowpayai/inflow-core` is private (workspace-only).
- One npm channel: `latest`.
- The skill version in `skills/agentic-payments/SKILL.md` frontmatter is auto-synced from `packages/cli/package.json`
  via `scripts/align-skill-version.js` during `pnpm build`. Don't hand-edit the skill's `version:` line.
- CI runs `pnpm --filter @inflowpayai/inflow publish --dry-run --no-git-checks` on every push to `main` to catch
  publishability regressions before they bite.

## When stuck

- Project overview, install, and usage: root `README.md`.
- Core package API reference: `packages/core/README.md` and the generated TypeDoc.
- CLI command reference: `packages/cli/README.md`.
- Tool configuration: the configs themselves (`turbo.json`, `tsconfig.base.json`, `eslint.config.js`,
  `.prettierrc.json`, per-package `tsup.config.ts` and `vitest.config.ts`).

## Working as an agent

These rules apply to LLM agents picking up tasks in this repo. They aren't enforceable by CI; the cost of breaking them
is wasted reviewer cycles or a regression that ships.

### Interaction

- **Ask when the task is underspecified.** Surface missing **facts** before writing: which command group, which output
  mode (interactive vs. agent), which environment, which credential model. These are knowable — don't guess. For design
  choices, see the architect rule below.
- **Don't execute on questions, ideas, or plans until the user explicitly says so.** A question is a question; a plan is
  a plan. Wait for an unambiguous "go" / "do it" / "yes" before writing code or files. Surfacing options is not approval
  to pick one.
- **You are the architect; the user is the decision maker.** For **design choices** — how to structure something, which
  pattern to apply, what to name a thing — propose, recommend, and surface the tradeoffs. Don't punt them back as
  open-ended questions ("what would you like to do?"), and don't make them unilaterally. The user approves or redirects.
- **No hand waving.** Be concrete and specific. No "should generally", "consider whether", "this might work" — if you
  have a recommendation, make it; if you don't, name what you'd need to know to form one.
- **When explaining, ground the explanation.** Don't state a rule, a tradeoff, or a behavior without the referent —
  point at the file, quote the call site, sketch the example or the solution. A claim without a referent is noise.

### Code work

- **Don't guess at signatures or behavior.** If you don't know what a function does, read it. If you don't know what a
  type exports, check the barrel.
- **Don't fabricate.** Never claim a function exists, a type is exported, or a behavior is implemented without
  verifying. If something looks like it should exist but doesn't, surface that — don't invent it.
- **Don't improvise patterns.** If a similar problem is already solved in this repo, follow the existing pattern. Adding
  a new helper, util, or dependency without justifying why the existing pattern doesn't cover the case is rejected on
  review.
- **Research before writing.** Read the related code first. Then grep for the symbol in question to see how it's used
  elsewhere. Then write.
- **Minimal diffs.** Change as little as possible to achieve the goal. Don't reformat unrelated lines, don't sweep style
  fixes across files outside your scope, don't bump dependencies unless the task is the bump.
- **Comments are part of the diff.** A 14-line comment above a 9-line code change is not a minimal diff. See the comment
  rule under [Conventions](#conventions).

### Done

- **Verify before claiming done.** Run `pnpm typecheck && pnpm lint && pnpm test` (and `pnpm typedoc` if the core
  package's public surface or any `{@link}` changed) before reporting success. "It looks right" is not verification.
- **Surface conflicts; don't paper over them.** If the request would require breaking a convention above, stop and say
  so. Don't reach for `eslint-disable`, `@ts-ignore`, or `as any` to make a check pass.
- **No "TODO" / "phase 2" escape hatches.** If a piece of work is out of scope, drop it cleanly and note it — don't
  leave a stub or a comment promising future cleanup.
- **Report what you actually did.** Files touched (with line counts), verification commands run with outcomes, and any
  surprises that should land in a separate change.
