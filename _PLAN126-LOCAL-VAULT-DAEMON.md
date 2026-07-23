# Task 126 - Local Vault Daemon Implementation Plan

This plan implements the Task 126 queue item from `_QUEUE2-SIGNED-SECURE-CLI.md`.

The target is a macOS-first proof of the cross-platform local vault model. The implementation must keep protocol
intelligence in CLI/Core and make the daemon a secure dumb vault. The daemon is not an AEP, MPP, x402, payment, HTTP, or
signing engine.

## Non-negotiable decisions

- Do not use macOS Keychain for credential payload storage.
- Do not use SQLite SEE.
- Evaluate `better-sqlite3-multiple-ciphers` only as optional database-encryption defense-in-depth.
- Record-level vault encryption is mandatory.
- Use Argon2id first. `scrypt` is only an explicit fallback if Argon2id cannot pass package/signing/release constraints.
- Use AES-256-GCM for authenticated encryption.
- Use one SQLite database for searchable metadata and encrypted vault records.
- Use a minimal binary bootstrap sidecar, not JSON.
- The bootstrap sidecar stores only `salt`, `nonce`, `tag`, and `material`.
- `material` is AES-256-GCM encrypted random 32-byte vault master key material.
- Stable cryptographic choices are hardcoded in the signed binary.
- CLI/Core owns protocol behavior. The daemon owns secret custody only.
- The local vault is not a multi-owner database. Logout/reset remove local user state.
- `inflow auth logout` performs local first-install cleanup, equivalent to `inflow vault reset`, plus selected remote
  cleanup when feasible.
- `inflow vault setup` does not exist.
- `inflow vault unlock` creates the vault on first use.
- Agent/MCP/non-TTY flows must not accept PIN/passphrase input.
- Daemon mode is hidden from help, docs, skills, generated language-model docs, MCP tools, shell completion, and
  installer copy.

## Source-backed current secret inventory

The implementation must derive final `VaultSecretKind` values from source inspection before adding enum values. Do not
add generic protocol kinds without a storage caller.

Current persisted secret references found in `packages/core/src/utils/storage.ts`:

| Secret category                 | Source                                                  |
| ------------------------------- | ------------------------------------------------------- |
| Device-flow access token        | `setAuth()` creates `auth-access-token`.                |
| Device-flow refresh token       | `setAuth()` creates `auth-refresh-token`.               |
| Saved InFlow API key            | `setApiKey()` creates `api-key`.                        |
| Pending device auth device code | `setPendingDeviceAuth()` creates `pending-device-code`. |
| AEP credential payload          | `setAepState()` creates `aep-credential`.               |

Before finalizing `VaultSecretKind`, inspect:

- AEP identity storage to determine whether any identity seed/private material is currently durable and secret-bearing.
- MPP/x402 flows to confirm payment credentials are not durable local secrets.

Final rule:

- Every `VaultSecretKind` must have at least one source-backed storage caller.
- Every source-backed durable secret storage caller must map to exactly one `VaultSecretKind`.
- Do not add `payment_credential` or `aep_identity_seed` unless source inspection proves durable secret persistence.

## Batch 1 - Cryptographic vault core, no daemon

Implement and test the crypto/storage primitives without IPC first.

Tasks:

- Evaluate `argon2` and `@node-rs/argon2` against:
  - Node 24.15
  - package maintenance and dependency surface
  - ESM compatibility
  - native-module packaging
  - macOS signing/notarization constraints
  - future Windows/Linux artifact constraints
- Benchmark Argon2id:
  - primary: 64 MiB memory, 3 iterations, parallelism 1, 32-byte output
  - fallback only if necessary: 32 MiB memory, 3 iterations, parallelism 1, 32-byte output
- Implement binary sidecar parser/writer:
  - fixed hardcoded format version
  - fields: `salt`, `nonce`, `tag`, `material`
  - reject missing, malformed, wrong-length, trailing, or truncated fields
- Implement master-key creation and unwrap:
  - generate random 32-byte vault master key
  - derive key-encryption key from PIN/passphrase with Argon2id
  - wrap/unwrap `material` with AES-256-GCM
  - hardcoded associated data such as `inflow-vault-header-v1`
- Derive separate keys from the unwrapped master key using domain separation:
  - `inflow vault record encryption`
  - `inflow sqlite database encryption` if database encryption is adopted
- Implement record-level AES-256-GCM encryption:
  - per-record nonce
  - tag
  - ciphertext
  - authenticated data binding for ref, kind code, record encryption version, and other retrieval-constraining metadata
- Implement versioned per-kind payload envelopes.
- Implement stable integer mappings:
  - `VaultSecretKind`
  - `VaultRecordStatus`: `1 = active`, `2 = pending`, `3 = deleting`
- Implement one SQLite database with:
  - searchable protocol metadata tables
  - exact-reference encrypted vault record table
- Implement reset/logout file cleanup:
  - remove `inflow.sqlite3`
  - remove `inflow.sqlite3-wal`
  - remove `inflow.sqlite3-shm`
  - remove the vault sidecar
  - remove stale daemon socket/runtime artifacts

Verification:

- Argon2id package audit and benchmark result recorded.
- Sidecar malformed/tamper tests fail closed.
- Passphrase change rewraps only `material`.
- Old passphrase fails after change.
- Record tamper tests fail closed for modified ciphertext, nonce, tag, ref, kind, status, and encryption version.
- Payload-envelope tests cover round trip, malformed payloads, and unknown versions.
- Mapping tests reject unknown integer codes and reserve retired codes.
- Copied database cannot recover plaintext without the unlock factor.
- Reset/logout file cleanup removes database, write-ahead log, shared-memory, sidecar, and runtime socket artifacts.

## Batch 2 - Generic `VaultBackend`

Create the pluggable interface that CLI/Core protocol code will use.

Interface scope:

- `status`
- `unlock`
- `lock`
- `getPolicy`
- `setPolicy`
- `putSecret`
- `getSecret`
- `deleteSecret`
- `exists`
- `touch`
- `deleteExpired`

Retrieval contract:

```ts
getSecret({
  reference,
  expectedKind,
});
```

Rules:

- `reference` is opaque, generated, and exact.
- Use a shape such as `vlt_` plus a ULID/UUID/random identifier.
- Do not encode user ID, Service DID, grant type, environment, credential type, or protocol fields in the portable ref.
- Backend implementations may map the opaque ref into provider-specific paths internally.
- Reject partial references.
- Reject search by metadata.
- Reject search by value.
- Reject list-payload/export/decrypt-arbitrary operations.
- Reject wrong kind, missing ref, pending ref, deleting ref, deleted ref, and expired ref.

Verification:

- AEP, MPP, x402, auth, API-key, and pending-auth storage depend on `VaultBackend`, not daemon internals.
- Every secret kind has a source-backed caller.
- Every caller has one kind.
- Tests prove no payload listing/export path exists.

## Batch 3 - Local daemon IPC

Implement the daemon as a secure dumb vault over local IPC.

IPC:

- Local operating-system IPC, not HTTP.
- macOS proof uses Unix domain socket under a user-owned private runtime directory.
- Use bounded length-prefixed JSON messages.
- Request shape: `{ version, id, method, params }`.
- Response shape: `{ version, id, ok, result | error }`.

Allowed methods:

- `vault.status`
- `vault.unlock`
- `vault.lock`
- `vault.changePassphrase`
- `vault.reset`
- `vault.getPolicy`
- `vault.setPolicy`
- `secret.put`
- `secret.get`
- `secret.delete`
- `secret.exists`
- `secret.touch`
- `secret.deleteExpired`
- internal `daemon.shutdown`

Rejected method classes:

- HTTP fetch
- AEP
- MPP
- x402
- payment
- signing
- approval
- command execution
- raw-secret export/list/search

Runtime behavior:

- The daemon stores unwrapped key material only in memory while unlocked.
- Do not store key material as JavaScript strings.
- Base64 is not protection.
- Zero buffers on lock/exit where practical.
- Unlock retry throttling is daemon-memory-only.
- Restart clears retry throttle state.

Verification:

- IPC tests cover success, typed errors, malformed frames, max-size rejection, unknown version, unknown method, no batch
  support, and secret redaction.
- Method-surface tests prove only approved methods are registered.
- Socket tests cover wrong permissions, wrong owner, symlink path, stale socket, and fake socket.
- Throttle tests prove delays during one daemon lifetime and reset after daemon restart.

## Batch 4 - macOS peer verification

Implement release-mode peer verification behind a platform adapter.

Rules:

- Release/package mode fails closed if peer verification cannot be completed.
- Development/test mode may bypass only through explicit development configuration.
- Same-user checks are defense-in-depth, not the complete boundary.
- No raw-secret/list/export API exists even for verified callers.

macOS release verifier:

- Require private runtime directory ownership and permissions.
- Require same effective user.
- Obtain peer process identifier through a native platform adapter. Node's public `net` socket API is not sufficient for
  release-mode peer verification because it does not expose Unix-socket peer credentials or peer process identifiers.
- Resolve peer executable.
- Verify signed InFlow executable identity:
  - expected Team ID
  - expected designated requirement / signing identity
- Reject unsigned, wrong signer, wrong executable, missing peer process, failed resolution, unavailable native verifier,
  and failed signature check.
- Do not use `lsof`, caller-provided process identifiers, caller-provided executable paths, or shared filesystem tokens
  as the release-mode verifier. They may be test fixtures, but not the security boundary.

Verification:

- Packaged-build tests or smoke scripts cover accepted signed InFlow client.
- Negative tests cover unsigned client, wrong Team ID, wrong path, missing peer process, and process-exit race.
- Development bypass tests require explicit opt-in and are impossible in release mode.

Current macOS evidence:

- Ad-hoc packaged app loads native vault dependencies and fails closed when peer verification is required.
- Developer ID signed, non-notarized packaged app accepts the expected Team ID `B96U57DTR2`.
- Peer-verifier tests cover wrong Team ID through explicit verifier options, not environment overrides.
- Local Developer ID signing required interactive Keychain approval.
- Local notarization is not yet verified because the `inflow-notary` notarytool profile is missing.

## Batch 5 - CLI/Core integration and command surface

Commands:

- `inflow vault status`
- `inflow vault unlock`
- `inflow vault lock`
- `inflow vault policy`
- `inflow vault set-policy`
- `inflow vault change-passphrase`
- `inflow vault reset`

No command:

- `inflow vault setup`

First-run human prompt:

```text
No InFlow vault exists yet.
Create a PIN or passphrase to protect local InFlow credentials.
```

Behavior:

- Human TTY credential-using commands may initialize or unlock inline, then continue the original command.
- Agent/MCP/non-TTY commands must not accept PIN/passphrase.
- Agent/MCP/non-TTY uninitialized vault returns `VAULT_NOT_INITIALIZED` with human action to run `inflow vault unlock`.
- Agent/MCP/non-TTY locked vault returns `VAULT_LOCKED` with human action to run `inflow vault unlock`.
- The locked/uninitialized message must make clear that a human must run the command; the agent must not provide the
  PIN/passphrase.

Lock policy:

- default idle timeout: 8 hours
- lock on sleep: true
- policy is deleted by logout/reset

Logout/reset:

- `inflow auth logout` performs local first-install cleanup and shuts down the vault daemon, plus selected remote
  cleanup when feasible.
- `inflow vault reset` performs local first-install cleanup with no remote calls.
- Remote cleanup attempts only credentials that are long-lived or lack definitive expiration.
- Reset/logout first request daemon lock-and-shutdown.
- If daemon is absent, continue cleanup.
- If daemon is alive and refuses or times out, return `VAULT_DAEMON_BUSY` and do not delete database or sidecar files.

Verification:

- Command help/docs/MCP expose `inflow vault ...` commands.
- No public surface exposes daemon mode.
- Recursive scan proves `--daemon` is absent from help, README, skills, generated docs, MCP schemas, completions, and
  installer copy.
- TTY first-run initialization tests pass.
- Agent/MCP `VAULT_NOT_INITIALIZED` tests pass.
- TTY locked inline unlock tests pass.
- Agent/MCP `VAULT_LOCKED` tests pass.
- No passphrase fields appear in MCP schemas, logs, or structured outputs.
- Logout/reset delete database, sidecar, write-ahead log, shared-memory, socket, public caches, vault policy, encrypted
  records, daemon state, AEP state, pending auth, API key, and auth tokens.
- Next login starts with first-run vault creation and cannot inherit previous policy, records, caches, or unlock state.

## Batch 6 - Optional encrypted SQLite evaluation

Evaluate `better-sqlite3-multiple-ciphers`.

Adopt only if all pass:

- Node 24.15 compatibility.
- ESM compatibility.
- package maintenance and dependency audit.
- native-module signing/notarization.
- packaged macOS app smoke.
- future Windows/Linux artifact feasibility.
- deterministic release behavior.
- no weakening of record-level vault encryption.

If adoption fails:

- Do not block Task 126.
- Keep mandatory record-level vault encryption.
- Record encrypted SQLite as a follow-up hardening task.

## Full verification gates

Before handoff:

- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`
- `pnpm typedoc`
- `pnpm build`
- package/signing smoke where changed paths require it
- `git diff --check`

Coverage:

- Patch coverage must meet the repository Codecov gate before creating a pull request.
- Add tests for new error branches, helper branches, schema branches, and negative-security paths.

Report:

- List changed files.
- List exact commands run and outcomes.
- List any skipped checks explicitly.
- State whether encrypted SQLite was adopted or deferred and why.
