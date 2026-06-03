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
  `inflow.depositAddresses` (IDepositAddressResource), `inflow.x402` (IX402), `inflow.mpp` (IMpp). Each handle carries
  the typed HTTP primitives plus the command-shaped operations (reducers + async-iterable drivers for the stateful
  commands). No UI dependencies; an ESLint `no-restricted-imports` rule scoped to `packages/core/src/**` enforces this.
- `@inflowpayai/inflow` (`packages/cli`) — the published binary. Consumes the core package; renders Ink/React for TTY
  mode and structured output for agent mode. The CLI commands are thin render shells over the core flows.

## Repo map

- `packages/cli/` — `@inflowpayai/inflow`, the published binary.
- `packages/core/` — `@inflowpayai/inflow-core`, the typed HTTP client.
- `plugins/inflow/` — the plugin bundle: `.claude-plugin/plugin.json`, `.cursor-plugin/plugin.json`,
  `.codex-plugin/plugin.json`, plus symlinks `skills → ../../skills`, `.mcp.json → ../../.mcp.json`,
  `assets → ../../assets` (so each per-plugin manifest's `./skills/`, `./.mcp.json`, and `./assets/` paths resolve).
- `skills/agentic-payments/SKILL.md` — the single skill file.
- `.claude-plugin/marketplace.json` — Claude Code marketplace entry.
- `.cursor-plugin/marketplace.json` — Cursor marketplace entry.
- `.agents/plugins/marketplace.json` — agents marketplace entry.
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
- **No stub comments.** Don't leave `TODO`, `phase 2`, or `refactor later` notes in shipped code — describe what the
  code does now, or delete the comment. This is about comments, not scope: splitting a task, deferring genuinely
  out-of-scope work to a separate change, or stopping to confirm direction is expected, not a violation.
- **Comments only for what the code can't say.** No restatement of behavior, no rationale-padding, no historical
  justification. Applies to every comment syntax — TSDoc, inline, YAML, shell, JSON-with-comments.
- **Write to the current state, not the change.** Comments and docs address a reader who has only the current tree —
  never a prior version they can't see. Don't phrase a fact relative to what changed: avoid "now", "no longer",
  "previously", "used to", "removed", "renamed", "added behavior", "prior/pre-X behavior", "reshaped". State the fact
  directly — not "the flag no longer defaults to true" but "the flag defaults to false". This bans the framing, not the
  fact: documenting a notable absence is fine. Change-relative narration belongs in the Changeset and commit message,
  not in code or docs.
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

### Non-negotiables

These three come before the pressure to finish quickly. When they conflict with "get it done," they win.

- **Check the contract before you build on it.** Before you rely on anything across a boundary — an endpoint's audience,
  authentication, and response shape; what a function or framework actually does; what another package exports — read
  the authoritative source and cite where you found it (file and line) in your report. Two things looking alike by name
  is not proof: a seller "config" endpoint is not the buyer "supported" endpoint just because both describe
  capabilities. If the right target does not exist, or the instruction is ambiguous, stop and ask.
- **Pausing to confirm is never a failure.** Shipping on an unchecked assumption is. You may stop at any point — to
  confirm context, check a fact, or ask for direction — and you are encouraged to do so at a low threshold, before you
  have committed to an approach.
- **Do not trust a check that fakes the thing you are unsure about.** A test or stand-in that imitates the exact
  behavior you have not verified proves nothing about the real thing. Confirm against the real implementation.

### Interaction

- **Confirm you have the right context before doing the work.** Surface missing facts before writing — and treat a fact
  you have not checked against the source as missing. Knowable facts here include which command group, which output mode
  (interactive or agent), which environment, and which credential model. If a fact is knowable by reading the code, read
  it and cite where you found it before relying on it. When you are unsure about scope, intent, or whether you have
  enough to proceed, stop and ask. A low bar for asking is preferred over guessing.
- **Don't execute on questions, ideas, or plans until the user explicitly says so.** A question is a question; a plan is
  a plan. Wait for an unambiguous "go" / "do it" / "yes" before writing code or files. Surfacing options is not approval
  to pick one.
- **You are the architect; the user decides.** For how to structure, name, or pattern something, propose and recommend
  with the tradeoffs. When the choice is genuinely the user's — a public interface or output shape, scope, anything
  touching money or credentials, or anything where their words are ambiguous — ask. A short question that lays out the
  options and your recommendation is the right move, not a failure; only the bare, analysis-free "what do you want?" is
  discouraged. Ask in the chat as a numbered list — each item with a little context or an example, any options to choose
  from, and your recommendation — rather than a tool that limits the number of questions or the space to read them.
- **No hand waving.** Be concrete and specific. No "should generally", "consider whether", "this might work" — if you
  have a recommendation, make it; if you don't, name what you'd need to know to form one.
- **When explaining, ground the explanation.** Don't state a rule, a tradeoff, or a behavior without the referent —
  point at the file, quote the call site, sketch the example or the solution. A claim without a referent is noise.
- **No abbreviations.** Spell things out in replies, comments, and docs. Don't use abbreviations or acronyms the reader
  may not know (for example, don't write "DoD" for "definition of done"). Names this codebase already uses are fine.

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
- **Cross-repository work.** When a change depends on another repository's behavior, confirm that behavior in that
  repository before writing code against it.
- **Don't silently drop work.** If something you would treat as out of scope is actually needed to finish the agreed
  goal, do not skip it without a word — surface it and ask how to proceed.
- **Minimal diffs.** Change as little as possible to achieve the goal. Don't reformat unrelated lines, don't sweep style
  fixes across files outside your scope, don't bump dependencies unless the task is the bump.
- **Comments are part of the diff.** A 14-line comment above a 9-line code change is not a minimal diff. See the comment
  rule under [Conventions](#conventions).

### Done

- **Run the real checks before you say it works.** Run the full gate set this repo defines — `tsc` against both the
  source config and the test config, lint, tests, and `pnpm typedoc` when the public surface or a documentation link
  changed — not a subset. In your report, name each command you ran and its result. Never write "done", "passing", or
  "verified" for a check you did not actually run; if you could not run one (for example, the environment cannot), say
  so plainly and hand it off — do not imply it passed. Do not claim tests or coverage pass without running the suite.
- **Surface conflicts; don't paper over them.** If the request would require breaking a convention above, stop and say
  so. Don't reach for `eslint-disable`, `@ts-ignore`, or `as any` to make a check pass.
- **Show your work in the report.** List the files you changed, the exact commands you ran with their outcomes, and mark
  each assumption as either checked-against-its-source or not-yet-checked. The reader should be able to see what is
  verified and what is not without rerunning anything.
