# Task 126 - Local Vault Daemon Implementation Plan

This plan implements the Task 126 queue item from `_QUEUE2-SIGNED-SECURE-CLI.md`.

The target is a macOS-first proof of the cross-platform local vault model. The implementation must keep protocol
intelligence in CLI/Core and make the daemon a secure dumb vault. The daemon is not an AEP, MPP, x402, payment, HTTP, or
signing engine.

## Accepted Improved proposal

This proposal is the controlling security specification.

### Accepted architecture clarification

- One InFlow application executable and process identity contains CLI, MCP, and daemon behavior.
- Security-sensitive native code may be a packaged native library loaded into that process when it is fixed-path,
  non-user-writable, platform-signed or integrity-bound, verified before loading, and never executed as a separate
  helper identity.
- Standard Node native modules are permitted under this rule.
- Do not build a custom Node runtime, use Electron, or extract native code to a temporary path.

### A. One executable architecture proof

- Prove one InFlow executable and process identity can load the native security core as an integrity-bound packaged
  component.
- CLI, MCP, daemon dispatch stay same executable.
- macOS signing/notarization, Linux ARM64/AMD64, Windows feasibility.
- No separate native executable identity, writable native library, or temporary extraction.

### B. Cross-platform mutual peer verification

- Internal abstraction like:

  ```ts
  interface VerifiedLocalPeer {
    executableIdentity: string;
    processId: number;
    userIdentity: string;
  }
  interface LocalPeerVerifier {
    verifyClient(connection: LocalConnection): VerifiedLocalPeer;
    verifyServer(connection: LocalConnection): VerifiedLocalPeer;
  }
  ```

- Both directions verify before protocol traffic.
- Platform facts + shared enforcement: exact app identity, executable, user/session relationship, build/install
  identity, fail closed.

### C. Rust protected-memory core

- Move only master-key lifecycle, key derivation, record encryption/decryption, zeroization, memory locking/dump
  exclusion, platform peer inspection.
- Preserve CRUD semantics and repository orchestration unless security invariant demands movement.

### D. Unified executable hardening

- Cross-platform matrix:
  - Publisher identity: Developer ID / signed Linux digest-package trust / Authenticode.
  - Client verifies daemon required.
  - Daemon verifies client required.
  - Canonical executable required.
  - Protected key memory native.
  - Dump/debug restrictions platform-specific.
  - Strict state permissions.
  - Fake client and fake server rejection.

### E. Adversarial verification before features

- Tests: fake client, fake daemon/socket, correct signer wrong path, wrong signer correct-looking path, replacement
  after daemon start, symlink launcher, PID reuse, peer exit during verify, missing verification service, unreadable
  executable, cross-user, malformed/oversized/truncated frames/reset, locked access, dump attempt, plaintext scan,
  binary/native tampering, upgrade while daemon running, downgrade.
- No installer/APT/new vault ops/payment policies/external provider implementation until invariants pass.

### Native Linux verification

- The bounded packaged release smoke passes on native ARM64 and AMD64 GitHub runners. Both architectures verify native
  module loading, daemon startup, vault initialization and unlock, credential round trip, Debian installation and
  system-vault behavior, tamper rejection, artifact attestation, and artifact upload.

### Remaining core security work

- Implement an installer-managed, socket-activated Linux daemon under a dedicated `inflow` service account and disable
  dumpability. Debian and RPM packages create the account and service; the executable remains world-executable.
- Implement the equivalent Windows service under a dedicated service identity.
- Wire the multi-tenant backend manager into the installer-managed services. Authenticated socket peers are routed to
  server-selected tenant backends, client-requested global service shutdown is rejected, and tenant reset does not stop
  the service. Each backend owns a separate database, `inflow.vault`, protected key, policy, lock state, and lifetime.
  Requests for one tenant are serialized while different tenants remain independent. IPC never accepts a caller-selected
  tenant identifier.
- Complete adversarial dump and plaintext scanning and upgrade/downgrade verification.
- Implement and verify equivalent protected memory, mutual peer authentication, package integrity, and process hardening
  on Windows.

### Approved platform service model

- Linux uses one installer-managed, socket-activated, multi-tenant daemon under a dedicated `inflow` service account.
- Windows uses one installer-managed, on-demand, multi-tenant service under a dedicated Windows service identity.
- macOS retains the signed, hardened per-user daemon. A real same-user task-memory probe must remain in the packaged
  smoke suite and must fail to obtain or read the daemon task.

### Verified Linux implementation status

The Linux service-account and multi-tenant bullets under Remaining core security work are implemented for ARM64:

- systemd owns `/run/inflow/vault.sock`; Debian and RPM installation create the `inflow` account and state directories.
- The root authentication broker and unprivileged vault are two modes of `/opt/inflow/bin/inflow`, not separate
  executable identities.
- The broker holds only `CAP_SYS_PTRACE`, `CAP_SETUID`, and `CAP_SETGID`. It authenticates the client executable and
  kernel identity, answers a fixed Ed25519 machine-identity challenge, and transfers the accepted socket descriptor. It
  does not parse vault frames or open tenant vault files.
- The vault runs as `inflow` with no permitted or effective capabilities. It verifies that transferred socket
  credentials match the broker attestation before reading a vault frame.
- Root and an ordinary user completed packaged lock, unlock, API-key login, and status operations through the same
  systemd socket. The ordinary user could not read the vault process memory, and the broker held no tenant-vault file
  descriptors.
- The ARM64 Debian lifecycle passed initialization, upgrade, downgrade, credential persistence, broker-identity
  continuity, capability checks, and persistent-file and resident-memory scans for raw UTF-8, Base64, hexadecimal, and
  UTF-16 representations of the passphrase and stored API key.
- The emulated AMD64 build and native AMD64 release runner pass the root-owned standalone package smoke and the
  installed Debian multi-tenant service smoke, including peer rejection, cross-user isolation, capability checks, and
  persistent-file and resident-memory scans.
- The AMD64 RPM contains the same executable bytes as the tested Debian package, preserves the single-executable payload
  without RPM stripping, uses portable systemd lifecycle scripts, starts successfully after extraction, and contains no
  group- or world-writable runtime files.
- Debian and RPM installation fails closed instead of reusing a conflicting human `inflow` login account. A compatible
  service identity is a non-root system user with `/var/lib/inflow` as its home and a non-login shell.
- IPC attachments use a fresh random mask before entering transport frames. The mask is not treated as transport
  encryption; it prevents stale Node transport allocations from retaining raw, Base64, hexadecimal, or UTF-16 secret
  representations after the tracked decoded buffer is wiped.
- Debian and RPM package transitions stop both service and activation socket before restarting socket activation.
  Corrected package transitions shut down the broker and vault cleanly without privileged process signaling.
- The signed macOS package rejects a tampered native module, a fake daemon, an unsigned client, and same-user
  task-memory access. Its isolated smoke can run alongside a normal user daemon, requires its own daemon process to exit
  after logout, and scans persistent state for raw UTF-8, Base64, hexadecimal, and UTF-16 representations of the unlock
  factor and stored API key.
- Signed macOS in-place upgrade, downgrade, and re-upgrade transitions preserve the encrypted vault and stored API key,
  replace incompatible running daemons, require a fresh human unlock after daemon replacement, and leave no raw UTF-8,
  UTF-16, Base64, lowercase hexadecimal, or uppercase hexadecimal secret representation in persistent vault files.

### Verified Windows implementation status

- The ARM64 native module uses Windows virtual memory locking, same-process memory protection, process mitigations,
  Windows CNG for HKDF-SHA256 and AES-256-GCM, and the pinned Argon2 `20190702` reference implementation.
- The Windows production native-build path passes cross-platform key-derivation parity, authenticated-encryption
  round-trip, and authentication-tag tamper rejection.
- Named-pipe peers are verified before vault protocol frames are transmitted. The client verifies the daemon before
  sending a fixed non-secret authentication handshake; the daemon uses that handshake to establish the Windows
  impersonation context and verifies the client before reading a vault frame. Verification binds the process identifier,
  canonical executable path, full user security identifier, Authenticode publisher, and signing-certificate thumbprint.
- The client grants only `PROCESS_QUERY_LIMITED_INFORMATION` on its own process to the `NT SERVICE\InFlowVault` security
  identifier. The unprivileged service receives no general process-inspection privilege.
- The signed ARM64 Windows Installer package installs an on-demand service under the passwordless
  `NT SERVICE\InFlowVault` virtual account. Signed package installation, service readiness, authenticated vault status,
  cancellable shutdown, executable/native-module integrity binding, and clean process exit pass in Windows 11 ARM64.
- Unit coverage exercises native-module integrity verification, mutual-authentication ordering, peer rejection, service
  dispatch, pipe request handling, malformed request rejection, lock control, and clean shutdown. The full repository
  test and coverage gate passes.
- The signed ARM64 package passes a reversible Windows security smoke that verifies the dedicated service identity,
  active process mitigations, authenticated vault status, client-side daemon identity rejection, daemon-side foreign
  client rejection before vault protocol data, native-module tamper rejection, restoration, and clean shutdown.
- The packaged client tolerates service startup and named-pipe instance replacement by retrying the complete
  wait-and-open operation within a bounded deadline. Twenty-five consecutive packaged status requests pass in Windows 11
  ARM64.
- Windows vault database path validation uses canonical-path and file-type checks; the installer-managed service-only
  access-control list protects the vault root. Unix user identifiers and permission bits are not treated as Windows
  ownership evidence. A native Windows backend run reaches the integrity-gated key-derivation boundary after creating
  its database.
- The signed ARM64 package passes first-run initialization, interactive unlock, API-key storage and retrieval through
  the mutually authenticated native transport, explicit lock, re-unlock, and credential persistence in Windows 11 ARM64.
  The stored credential is absent from persistent tenant vault files in raw UTF-8, UTF-16, Base64, lowercase
  hexadecimal, and uppercase hexadecimal representations.
- With the pagefile disabled and verified inactive, the packaged credential-storage path leaves no matching raw UTF-8,
  UTF-16, Base64, lowercase hexadecimal, or uppercase hexadecimal representation in readable committed memory owned by
  the long-lived vault service. The virtual machine's original automatically managed pagefile configuration was restored
  and verified active after reboot.
- The signed ARM64 package verifies unlock state through an independent status request before reporting success. Manual
  Windows Terminal testing confirms correct lock and unlock behavior, rejection of incorrect PINs and passphrases, and
  idempotent unlock without another credential prompt when the vault is already unlocked.
- The signed ARM64 MSI passes passphrase change, old-passphrase rejection, new-passphrase unlock, tenant reset, and
  clean vault reinitialization. Signed `0.9.0` and `0.9.1` MSI fixtures pass upgrade with vault preservation, direct
  downgrade rejection without state loss, supported uninstall/install rollback with vault preservation, and final
  re-upgrade with vault preservation.

Task 126 has no incomplete core-security verification. Linux and Windows production distribution work remains tracked
separately in `_QUEUE2-SIGNED-SECURE-CLI.md`.

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
