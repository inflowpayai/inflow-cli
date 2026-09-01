# @inflowpayai/inflow

## 0.12.2

### Patch Changes

- [#119](https://github.com/inflowpayai/inflow-cli/pull/119)
  [`6596cfa`](https://github.com/inflowpayai/inflow-cli/commit/6596cfacdc09aa8d602fd3d610f0b9e8f711418f) Thanks
  [@nkavian](https://github.com/nkavian)! - Show live progress while preparing an interactive AEP enrollment.

- [#122](https://github.com/inflowpayai/inflow-cli/pull/122)
  [`cbe67d5`](https://github.com/inflowpayai/inflow-cli/commit/cbe67d53204fd8fbf4600cf3dd4f04c2a4d09f55) Thanks
  [@nkavian](https://github.com/nkavian)! - Display ODP-advertised MCP endpoints during Service inspection.

- [#129](https://github.com/inflowpayai/inflow-cli/pull/129)
  [`37b7786`](https://github.com/inflowpayai/inflow-cli/commit/37b778646c5f5d83401dec355c0724964b1288bf) Thanks
  [@mnebliienko](https://github.com/mnebliienko)! - Preserve stable error codes in subscription MCP tool failures.

- [#123](https://github.com/inflowpayai/inflow-cli/pull/123)
  [`fb43b07`](https://github.com/inflowpayai/inflow-cli/commit/fb43b07d85cfaf60abc8676a1ebc94c5076fb82d) Thanks
  [@nkavian](https://github.com/nkavian)! - Update Offering Discovery Protocol support for payment origin declarations
  and preserve Service identifiers in directory results.

- [#127](https://github.com/inflowpayai/inflow-cli/pull/127)
  [`c5c30e0`](https://github.com/inflowpayai/inflow-cli/commit/c5c30e0e40e38ef5a97bba3808b8b85416feabae) Thanks
  [@nkavian](https://github.com/nkavian)! - Add capability-aware Trusted Agent Protocol request signing and
  redirect-safe transport support.

## 0.12.1

### Patch Changes

- [#117](https://github.com/inflowpayai/inflow-cli/pull/117)
  [`697155d`](https://github.com/inflowpayai/inflow-cli/commit/697155dbd27cbca033f3cd5a4df7d19091c950d4) Thanks
  [@nkavian](https://github.com/nkavian)! - Display advertised Service website, documentation, support, and status links
  during ODP inspection.

- [#118](https://github.com/inflowpayai/inflow-cli/pull/118)
  [`636ecde`](https://github.com/inflowpayai/inflow-cli/commit/636ecded235218e37d7bf1d2cc2038b46d6e7c76) Thanks
  [@nkavian](https://github.com/nkavian)! - Make interactive authorization and payment waits stoppable with Escape, and
  complete remote approval cancellation before ending the command.

- [#118](https://github.com/inflowpayai/inflow-cli/pull/118)
  [`636ecde`](https://github.com/inflowpayai/inflow-cli/commit/636ecded235218e37d7bf1d2cc2038b46d6e7c76) Thanks
  [@nkavian](https://github.com/nkavian)! - Show Collection and Offering images in their full human-readable details.
  Show directory search help when no search input is provided, reject extra positional arguments, distinguish invalid
  directory responses from request failures, keep payment options out of the directory's protocol summary, and report
  missing, malformed, or unsupported AEP claims with structured remediation details that identify individual address
  fields.

- [#115](https://github.com/inflowpayai/inflow-cli/pull/115)
  [`d62b052`](https://github.com/inflowpayai/inflow-cli/commit/d62b052788d886e1f3a8aeb6b9f50d617b3e9b86) Thanks
  [@nkavian](https://github.com/nkavian)! - Show the actionable ODP error message in combined human inspection output.

## 0.12.0

### Minor Changes

- [#114](https://github.com/inflowpayai/inflow-cli/pull/114)
  [`98c94aa`](https://github.com/inflowpayai/inflow-cli/commit/98c94aa2731c53629d7422b2a7343bf7d051abe1) Thanks
  [@nkavian](https://github.com/nkavian)! - Add MPP subscription activation and protocol-neutral subscription management
  commands. Display recurring terms before approval, select among multiple subscription options with stable option
  identifiers, and provide list, get, fetch, and cancel commands. Each fetch obtains a fresh short-lived authorization
  from InFlow; no standing subscription credential is stored in the local vault. Subscription output includes active,
  past-due, expired, cancelled, revoked, pending, and failed lifecycle states plus the next scheduled billing attempt.
  Subscription output identifies the seller by name and presents the seller website as a hostname in human-readable CLI
  tables while retaining the complete website URL in structured output.

### Patch Changes

- [#113](https://github.com/inflowpayai/inflow-cli/pull/113)
  [`6e53f63`](https://github.com/inflowpayai/inflow-cli/commit/6e53f6367c4ed1091c733871870023bc5c6cf394) Thanks
  [@mnebliienko](https://github.com/mnebliienko)! - Advertise supported MPP method and intent pairs with
  `Accept-Payment` during payment and inspection probes while preserving explicit caller preferences.

- [#111](https://github.com/inflowpayai/inflow-cli/pull/111)
  [`240547e`](https://github.com/inflowpayai/inflow-cli/commit/240547e9e8b90542db5976ab776bc341b7a3180c) Thanks
  [@nkavian](https://github.com/nkavian)! - Add ODP payment-option filters, facets, and Service capability output.

## 0.11.3

### Patch Changes

- [#110](https://github.com/inflowpayai/inflow-cli/pull/110)
  [`8b8801b`](https://github.com/inflowpayai/inflow-cli/commit/8b8801bc08d99be2ed38a4f05b7e710043f5065e) Thanks
  [@nkavian](https://github.com/nkavian)! - Bundle runtime module imports used by MCP and network transports, accept
  empty directory suggestion results, and require the pinned Argon2 source when packaging Linux applications.

- [#108](https://github.com/inflowpayai/inflow-cli/pull/108)
  [`f43a58c`](https://github.com/inflowpayai/inflow-cli/commit/f43a58cc632bf60b79296e1626a62b03fd8f4f08) Thanks
  [@nkavian](https://github.com/nkavian)! - Select Windows installers using the native host architecture under
  PowerShell emulation and skip same-version MSI reconfiguration.

## 0.11.2

### Patch Changes

- [#105](https://github.com/inflowpayai/inflow-cli/pull/105)
  [`03373d5`](https://github.com/inflowpayai/inflow-cli/commit/03373d5bf0b0fbfdcc1369c906c6fb6f2804fe9f) Thanks
  [@nkavian](https://github.com/nkavian)! - Install verifier dependencies before staging and publishing native release
  assets.

## 0.11.1

### Patch Changes

- [#102](https://github.com/inflowpayai/inflow-cli/pull/102)
  [`870b4fb`](https://github.com/inflowpayai/inflow-cli/commit/870b4fb42a114365ceb467ffeaf97a430319f299) Thanks
  [@nkavian](https://github.com/nkavian)! - Fix Windows vault requests by closing each named-pipe connection exactly
  once.

## 0.11.0

### Minor Changes

- [#87](https://github.com/inflowpayai/inflow-cli/pull/87)
  [`c942115`](https://github.com/inflowpayai/inflow-cli/commit/c9421154ece45e7a3fca85b13d93faa367b88ca6) Thanks
  [@nkavian](https://github.com/nkavian)! - Add ODP Service directory search, inspection, Collection navigation,
  per-Service and federated Offering discovery, and read-only Action resolution. Protected catalog reads use the
  existing AEP runtime, and catalog caches are isolated by a verified access context or disabled. Resolved Action
  targets compose with the existing MPP and x402 payment commands. ODP failures return stable error codes without
  exposing internal errors or stack traces. Direct Service commands reject unadvertised operations with an actionable
  alternative, and the agentic discovery playbook guides capability-aware catalog navigation. Offering search exposes
  resolved filters and sorts, and aggregate discovery derives its required Service operation from the Offering request.
  The top-level inspect command reports ODP Service metadata before enrollment and payment details. Interactive ODP
  commands render tabular directory, Collection, Offering, capability, and Action results with copyable continuation
  commands and absolute schema-declared URLs. AEP Service identity mismatches fail with a stable non-retryable error.
  Offering lists include descriptions, Collection hierarchy labels use explicit terminology, and directory search
  presents facet counts as available filters over the complete matching result set. Offering details present structured
  Price Preview semantics and explicit Action and Offering identifiers. Invalid AEP Grant responses return a stable
  error instead of an internal-error fallback. Resource details omit Service-level ODP versions and empty localization
  metadata. Collection and Offering searches reject missing search criteria locally with actionable list-command
  guidance. Resolved compact Actions display their schema-declared inputs, required fields, and selectable values. MPP
  and x402 requests with `--data` retain the documented JSON content type through AEP-aware probes and payment replays.

### Patch Changes

- [#94](https://github.com/inflowpayai/inflow-cli/pull/94)
  [`a676003`](https://github.com/inflowpayai/inflow-cli/commit/a676003d8c42306b6e545f187bad480fcc83e80a) Thanks
  [@nkavian](https://github.com/nkavian)! - Protect vault initialization and credential rotation from partial
  vault-header writes.

- [#93](https://github.com/inflowpayai/inflow-cli/pull/93)
  [`1844276`](https://github.com/inflowpayai/inflow-cli/commit/1844276aafbe87e9bcd890eb9c29a13435c05c93) Thanks
  [@nkavian](https://github.com/nkavian)! - Bound AEP approval status and cancellation requests by their configured
  deadlines.

- [#98](https://github.com/inflowpayai/inflow-cli/pull/98)
  [`aebafd2`](https://github.com/inflowpayai/inflow-cli/commit/aebafd2154c59417bd1737efe8fe1d79a4ca402f) Thanks
  [@nkavian](https://github.com/nkavian)! - Treat assigned `--format=value` arguments as agent-mode output and normalize
  them for command parsing.

- [#97](https://github.com/inflowpayai/inflow-cli/pull/97)
  [`18e650d`](https://github.com/inflowpayai/inflow-cli/commit/18e650dfb196c1bf2d252068df44868b1d9fca4f) Thanks
  [@nkavian](https://github.com/nkavian)! - Report errors returned by streaming MCP commands and close interrupted
  command streams.

- [#99](https://github.com/inflowpayai/inflow-cli/pull/99)
  [`cee88f5`](https://github.com/inflowpayai/inflow-cli/commit/cee88f5d9e0c28641907f0ddbe3c1afeca7694bf) Thanks
  [@nkavian](https://github.com/nkavian)! - Restart a stopped vault daemon before persistent MCP tools that use
  vault-backed state.

- [#95](https://github.com/inflowpayai/inflow-cli/pull/95)
  [`6a8c182`](https://github.com/inflowpayai/inflow-cli/commit/6a8c182a441f782568b737db3c0112e81c25851a) Thanks
  [@nkavian](https://github.com/nkavian)! - Preserve usable credentials when replacement storage fails and retain
  recoverable secret cleanup work.

- [#96](https://github.com/inflowpayai/inflow-cli/pull/96)
  [`efb0a12`](https://github.com/inflowpayai/inflow-cli/commit/efb0a12a1276aaea6ddfdb8868597732fb6885b8) Thanks
  [@nkavian](https://github.com/nkavian)! - Preserve recoverable credential lifecycle state when secure storage deletion
  is temporarily unavailable.

- [#90](https://github.com/inflowpayai/inflow-cli/pull/90)
  [`b584f51`](https://github.com/inflowpayai/inflow-cli/commit/b584f513274a7b82adaf6995bd75e9e5c1f0850f) Thanks
  [@nkavian](https://github.com/nkavian)! - Preserve the executable and service configuration during Windows MSI
  upgrades, and authenticate the vault service by the server process identity reported by the named pipe.

- [#92](https://github.com/inflowpayai/inflow-cli/pull/92)
  [`261b3b2`](https://github.com/inflowpayai/inflow-cli/commit/261b3b2e06cf3c127327ba296667de4655ea150d) Thanks
  [@nkavian](https://github.com/nkavian)! - Reject Linux release key files containing untrusted additional primary keys
  and isolate verification state in a temporary directory.

## 0.10.3

### Patch Changes

- [#83](https://github.com/inflowpayai/inflow-cli/pull/83)
  [`5f1d720`](https://github.com/inflowpayai/inflow-cli/commit/5f1d720ef568813d79d1ff291379912cd10be085) Thanks
  [@nkavian](https://github.com/nkavian)! - Separate npm shim releases from runnable CLI builds that require the native
  vault peer verifier.

- [#77](https://github.com/inflowpayai/inflow-cli/pull/77)
  [`20125fb`](https://github.com/inflowpayai/inflow-cli/commit/20125fb9723fe20d518abed436b01d3574c6f894) Thanks
  [@nkavian](https://github.com/nkavian)! - Document Windows installation, upgrade, uninstall, direct-download, and
  release-operator workflows alongside macOS and Linux.

- [#81](https://github.com/inflowpayai/inflow-cli/pull/81)
  [`4402ef3`](https://github.com/inflowpayai/inflow-cli/commit/4402ef3a60caee679b598592dc1e7103dcfc0d8a) Thanks
  [@nkavian](https://github.com/nkavian)! - Clarify the top-level Agent Enrollment Protocol, inspect, Machine Payments
  Protocol, and x402 command descriptions.

- [#82](https://github.com/inflowpayai/inflow-cli/pull/82)
  [`c02edb2`](https://github.com/inflowpayai/inflow-cli/commit/c02edb2d084a9bf6ae4fcebb54a22ce8c9a060b4) Thanks
  [@nkavian](https://github.com/nkavian)! - Keep local-state vault handling independent from runtime InFlow API keys,
  report locked authentication status with a stable `VAULT_LOCKED` error, and isolate integration tests from the user's
  vault.

- [#80](https://github.com/inflowpayai/inflow-cli/pull/80)
  [`e321165`](https://github.com/inflowpayai/inflow-cli/commit/e3211657a904d83f2040851963fdf9d4d71c9793) Thanks
  [@nkavian](https://github.com/nkavian)! - Prevent command help and idempotent vault reset from requiring daemon
  startup, and restore verified development-daemon startup from the built CLI.

## 0.10.2

### Patch Changes

- [#71](https://github.com/inflowpayai/inflow-cli/pull/71)
  [`b4b4c97`](https://github.com/inflowpayai/inflow-cli/commit/b4b4c975363294a94ce49d4e2ceffb2f34ed7f4b) Thanks
  [@nkavian](https://github.com/nkavian)! - Publish verified macOS and Linux artifacts together through one immutable
  native release workflow.

- [#70](https://github.com/inflowpayai/inflow-cli/pull/70)
  [`177bad3`](https://github.com/inflowpayai/inflow-cli/commit/177bad36d0cedf10c638b02019beadd0fe53db98) Thanks
  [@nkavian](https://github.com/nkavian)! - Document the hosted signed-native installer as supporting macOS and Linux.

- [#68](https://github.com/inflowpayai/inflow-cli/pull/68)
  [`ec73126`](https://github.com/inflowpayai/inflow-cli/commit/ec73126903712f28163bf42772058034ea74334c) Thanks
  [@nkavian](https://github.com/nkavian)! - Remove encrypted vault data and broker identity keys when purging a Linux
  installation.

- [#72](https://github.com/inflowpayai/inflow-cli/pull/72)
  [`634136e`](https://github.com/inflowpayai/inflow-cli/commit/634136eb3959f5fffd27373e2a9b4e147fd148f8) Thanks
  [@nkavian](https://github.com/nkavian)! - Reject duplicate, missing, unexpected, corrupt, and digest-mismatched native
  release assets before publication.

## 0.10.1

### Patch Changes

- [#63](https://github.com/inflowpayai/inflow-cli/pull/63)
  [`db171ab`](https://github.com/inflowpayai/inflow-cli/commit/db171ab824eaded6cbfd92be12a392adc13a5544) Thanks
  [@nkavian](https://github.com/nkavian)! - Hide the hosted Windows installer from public setup instructions while
  production Artifact Signing approval is pending, and distinguish signed Linux release assets from future
  package-repository publication.

## 0.10.0

### Minor Changes

- [#39](https://github.com/inflowpayai/inflow-cli/pull/39)
  [`fda6120`](https://github.com/inflowpayai/inflow-cli/commit/fda6120e450644fd7461815b52d8f13cc25eb7e7) Thanks
  [@nkavian](https://github.com/nkavian)! - Add Agent Enrollment Protocol Service inspection, enrollment with Platform
  identity recovery and duplicate prevention, status, credential issuance, and revocation commands. Detect AEP
  authentication in the top-level inspect command and present AEP inspection and status details in tables. Store
  authentication secrets and AEP credential payloads in the encrypted local vault, with non-secret metadata in SQLite.
  On first use, delete the legacy plaintext `config.json` without migrating its credentials, requiring users to
  authenticate and enroll again. Add resource-aware AEP inspection and `aep fetch`, including anonymous success, caller
  request preservation, identity recovery, stored credential selection, pending Sign approval continuation, bounded
  redirects and responses, and structured resource body output. Persist fresh AEP Inspect documents per authenticated
  Platform user so separate CLI invocations reuse discovery safely. Ship a dedicated `agentic-enrollment` skill through
  the CLI, plugin, and web publication surfaces, and include every AEP command in language-model and MCP inventory
  regression coverage.

- [#46](https://github.com/inflowpayai/inflow-cli/pull/46)
  [`89b5464`](https://github.com/inflowpayai/inflow-cli/commit/89b54648a0fdb9ec3f5e3efc5396a3996bb42f3e) Thanks
  [@nkavian](https://github.com/nkavian)! - Publish macOS release artifacts for Apple Silicon and Intel Macs, render a
  multi-architecture Homebrew Cask, and point update/install messaging at the hosted install instructions.

- [#47](https://github.com/inflowpayai/inflow-cli/pull/47)
  [`f3e82c5`](https://github.com/inflowpayai/inflow-cli/commit/f3e82c566d31a06937b6d500558848341d6e7d1d) Thanks
  [@nkavian](https://github.com/nkavian)! - Publish the npm package as a compatibility notice that points users and
  agents to the signed native InFlow CLI instead of running commands or managing credentials.

  Check GitHub Releases for advisory signed-binary updates, surface a one-line human notice, return structured
  current/latest version metadata to agents, bound release checks to a short deadline, provide Homebrew and hosted
  installer upgrade guidance, and send the installed CLI version on InFlow API requests.

  Prepare native x64 and ARM64 Windows release payloads for Azure Artifact Signing, sign the executable before building
  the MSI, sign the MSI before generating checksums and WinGet manifests, and keep unsigned nonpublishing workflow
  validation available without production credentials.

- [#38](https://github.com/inflowpayai/inflow-cli/pull/38)
  [`ce2191a`](https://github.com/inflowpayai/inflow-cli/commit/ce2191a1a98095cb5bd05f2a38da451a545d94cb) Thanks
  [@nkavian](https://github.com/nkavian)! - Add MPP and x402 Fetch commands for completing deferred payment
  transactions, including structured continuation tool input from Pay, credential-safe seller replay, and
  replay-outcome-unknown error handling.

- [#39](https://github.com/inflowpayai/inflow-cli/pull/39)
  [`fda6120`](https://github.com/inflowpayai/inflow-cli/commit/fda6120e450644fd7461815b52d8f13cc25eb7e7) Thanks
  [@nkavian](https://github.com/nkavian)! - Make MPP and x402 pay/fetch AEP-aware. Seller requests complete AEP
  authentication before payment creation, compose non-colliding AEP and payment credentials on the final replay, and
  preserve the payment fetch continuation contract. AEP fetch reports payment-required handoffs, and combined inspect
  reports blocked AEP payment inspection without creating grants, approvals, or payments.

- [#35](https://github.com/inflowpayai/inflow-cli/pull/35)
  [`e4d4b0f`](https://github.com/inflowpayai/inflow-cli/commit/e4d4b0f712016f4de8240d1c7789b7d6571916c3) Thanks
  [@nkavian](https://github.com/nkavian)! - Require Node.js 24.15.0 or newer for the command-line package, development
  builds, and continuous integration.

- [#59](https://github.com/inflowpayai/inflow-cli/pull/59)
  [`6d3191c`](https://github.com/inflowpayai/inflow-cli/commit/6d3191cafd62461dce611a9f1adcea70a1b4c9e1) Thanks
  [@nkavian](https://github.com/nkavian)! - Add self-contained Linux archives, Debian and RPM system-service packages,
  and a checksummed hosted installer with encrypted local vault storage, same-executable Unix socket peer verification,
  and signed APT and RPM repository metadata.

### Patch Changes

- [#53](https://github.com/inflowpayai/inflow-cli/pull/53)
  [`552157e`](https://github.com/inflowpayai/inflow-cli/commit/552157e70766c9bc711c50d2ad21122873e2730f) Thanks
  [@nkavian](https://github.com/nkavian)! - Harden signed credential storage recovery for SQLite corruption, interrupted
  secret lifecycle work, and expired AEP credential cleanup.

- [#59](https://github.com/inflowpayai/inflow-cli/pull/59)
  [`51d6035`](https://github.com/inflowpayai/inflow-cli/commit/51d6035372c75d3bc0e7a15e126ef59837a3b420) Thanks
  [@nkavian](https://github.com/nkavian)! - Use the latest AEP libraries and keep the internal user profile command out
  of the CLI, MCP, and agent documentation surfaces.

- [#36](https://github.com/inflowpayai/inflow-cli/pull/36)
  [`647cec4`](https://github.com/inflowpayai/inflow-cli/commit/647cec443fa2a4ae970c4d91d84813955e6e3350) Thanks
  [@nkavian](https://github.com/nkavian)! - Add the SQLite metadata repository and transactional secret-lifecycle
  foundation used by the signed command-line application.

- [#50](https://github.com/inflowpayai/inflow-cli/pull/50)
  [`5fc1f7b`](https://github.com/inflowpayai/inflow-cli/commit/5fc1f7b9ce317b7ee0d0e24d40fa07e453b6a1d4) Thanks
  [@nkavian](https://github.com/nkavian)! - Display unsupported CLI version responses from InFlow as actionable upgrade
  errors.

- [#59](https://github.com/inflowpayai/inflow-cli/pull/59)
  [`51d6035`](https://github.com/inflowpayai/inflow-cli/commit/51d6035372c75d3bc0e7a15e126ef59837a3b420) Thanks
  [@nkavian](https://github.com/nkavian)! - Report locally stored active session credentials in AEP Status output and
  return an actionable not-enrolled error when the Service no longer recognizes the locally stored Agent identity.

- [#54](https://github.com/inflowpayai/inflow-cli/pull/54)
  [`9b9af54`](https://github.com/inflowpayai/inflow-cli/commit/9b9af54cb28e4b52cef250c64b70a7533b86cc02) Thanks
  [@nkavian](https://github.com/nkavian)! - Decode MPP receipts by their standard base fields and project nested
  settlement details in payment output.

- [#61](https://github.com/inflowpayai/inflow-cli/pull/61)
  [`f0e0f8a`](https://github.com/inflowpayai/inflow-cli/commit/f0e0f8a1a8f609d1dd30fe38e57dc60a78d5cde7) Thanks
  [@nkavian](https://github.com/nkavian)! - Declare the Linux RPM package under the repository's MIT license.

- [#51](https://github.com/inflowpayai/inflow-cli/pull/51)
  [`eed570b`](https://github.com/inflowpayai/inflow-cli/commit/eed570b39c3f5795fac3e00e24d4036a75c26588) Thanks
  [@nkavian](https://github.com/nkavian)! - Report rejected authenticated account requests as actionable authentication
  errors instead of generic failures.

- [#59](https://github.com/inflowpayai/inflow-cli/pull/59)
  [`51d6035`](https://github.com/inflowpayai/inflow-cli/commit/51d6035372c75d3bc0e7a15e126ef59837a3b420) Thanks
  [@nkavian](https://github.com/nkavian)! - Recognize the packaged command-line symlink as the same executable as its
  signed local vault daemon.

- [#59](https://github.com/inflowpayai/inflow-cli/pull/59)
  [`51d6035`](https://github.com/inflowpayai/inflow-cli/commit/51d6035372c75d3bc0e7a15e126ef59837a3b420) Thanks
  [@nkavian](https://github.com/nkavian)! - Make vault unlock idempotent when the vault is already unlocked and report
  rejected PINs or passphrases as unlock failures.

- [#54](https://github.com/inflowpayai/inflow-cli/pull/54)
  [`c84e078`](https://github.com/inflowpayai/inflow-cli/commit/c84e078ff9b657e9e2e195a803f810561aa8a019) Thanks
  [@nkavian](https://github.com/nkavian)! - Run MPP challenge, credential, and receipt handling against the pinned
  upstream conformance suite.

- [#60](https://github.com/inflowpayai/inflow-cli/pull/60)
  [`93dc1a1`](https://github.com/inflowpayai/inflow-cli/commit/93dc1a12960450144ae125e4cae55902ad09ddca) Thanks
  [@nkavian](https://github.com/nkavian)! - Exercise secure vault daemon, storage, client, peer-verification, and Agent
  Enrollment Protocol failure paths.

- [#59](https://github.com/inflowpayai/inflow-cli/pull/59)
  [`51d6035`](https://github.com/inflowpayai/inflow-cli/commit/51d6035372c75d3bc0e7a15e126ef59837a3b420) Thanks
  [@nkavian](https://github.com/nkavian)! - Replace incompatible running macOS vault daemons before commands access
  vault-backed state after an in-place application update.

- [#59](https://github.com/inflowpayai/inflow-cli/pull/59)
  [`51d6035`](https://github.com/inflowpayai/inflow-cli/commit/51d6035372c75d3bc0e7a15e126ef59837a3b420) Thanks
  [@nkavian](https://github.com/nkavian)! - Harden local vault transport limits, secret-reference integrity,
  locked-state reporting, terminal passphrase handling, credential cleanup, and signed-build compatibility checks.

- [#59](https://github.com/inflowpayai/inflow-cli/pull/59)
  [`51d6035`](https://github.com/inflowpayai/inflow-cli/commit/51d6035372c75d3bc0e7a15e126ef59837a3b420) Thanks
  [@nkavian](https://github.com/nkavian)! - Prepare the signed native CLI for local encrypted vault storage by packaging
  the vault daemon runtime, exposing vault lifecycle commands, enforcing daemon sleep-lock policy, adding macOS
  peer-verification plumbing, and wiring native dependencies.

- [#41](https://github.com/inflowpayai/inflow-cli/pull/41)
  [`d216e08`](https://github.com/inflowpayai/inflow-cli/commit/d216e08778c06f6cd856a3254b13c752df7a3ea8) Thanks
  [@nkavian](https://github.com/nkavian)! - Expand regression coverage for secure storage, payment completion failures,
  and AEP-aware payment inspection.

- [#59](https://github.com/inflowpayai/inflow-cli/pull/59)
  [`6d3191c`](https://github.com/inflowpayai/inflow-cli/commit/6d3191cafd62461dce611a9f1adcea70a1b4c9e1) Thanks
  [@nkavian](https://github.com/nkavian)! - Verify the Developer-ID-signed macOS package across vault initialization,
  credential persistence, process reuse, locking, peer rejection, logout, and daemon shutdown.

- [#40](https://github.com/inflowpayai/inflow-cli/pull/40)
  [`9a236ad`](https://github.com/inflowpayai/inflow-cli/commit/9a236adb636d4000fe75f7659e3b7f5a4f21225a) Thanks
  [@nkavian](https://github.com/nkavian)! - Add the macOS signed application packaging and Homebrew Cask rendering
  pipeline used for the InFlow command-line executable.

## 0.9.1

### Patch Changes

- Bundle the patched Incur runtime into the npm executable and smoke-test the packed package from a clean installation.

## 0.9.0

### Minor Changes

- [#33](https://github.com/inflowpayai/inflow-cli/pull/33)
  [`f7d709d`](https://github.com/inflowpayai/inflow-cli/commit/f7d709d43b9a6ee9765479e1d95ffcad6df6cfd6) Thanks
  [@nkavian](https://github.com/nkavian)! - Surface the MPP challenge `opaque` blob in `mpp decode` output and the
  settled `amount`/`currency` on the pay result.

### Patch Changes

- [#28](https://github.com/inflowpayai/inflow-cli/pull/28)
  [`c5a6e9d`](https://github.com/inflowpayai/inflow-cli/commit/c5a6e9d75b99aef7c4ecd0a2b332fc53742e3e18) Thanks
  [@mnebliienko](https://github.com/mnebliienko)! - Normalize balance decimal response strings before rendering CLI
  output.

- [#34](https://github.com/inflowpayai/inflow-cli/pull/34)
  [`c27ea56`](https://github.com/inflowpayai/inflow-cli/commit/c27ea56e85d69337be7843a189e5237c6578e261) Thanks
  [@nkavian](https://github.com/nkavian)! - Bump `@inflowpayai/mpp` to `^0.7.0` and `@inflowpayai/mpp-buyer` to
  `^0.6.1`.

- [#29](https://github.com/inflowpayai/inflow-cli/pull/29)
  [`15f963c`](https://github.com/inflowpayai/inflow-cli/commit/15f963cbaf8a895c518d2fac9eb0908286dd88c7) Thanks
  [@mnebliienko](https://github.com/mnebliienko)! - Default the production API base URL to `https://api.inflowpay.ai`
  for data endpoints, while OAuth/device auth keeps using `https://app.inflowpay.ai`. A single `INFLOW_BASE_URL` (or
  `apiBaseUrl`) override still redirects both hosts, so pointing the CLI at another environment stays a one-variable
  change.

## 0.8.0

### Minor Changes

- [#26](https://github.com/inflowpayai/inflow-cli/pull/26)
  [`30f0b97`](https://github.com/inflowpayai/inflow-cli/commit/30f0b976849ee2d424324c572f881dd37ce126b4) Thanks
  [@nkavian](https://github.com/nkavian)! - Surface Tempo MPP challenges in the `inspect`, `mpp inspect`, and `mpp pay`
  flows. Tempo challenges are projected and selected by their on-the-wire `amount` and `currency` — the same compact
  projection used for the `inflow` method — and can be paid with `--payment-method tempo`. The CLI carries no Tempo
  asset registry and no x402 concepts in the MPP path; currency/rail filters read the decoded challenge request
  directly. Also covers Tempo deposit-address data.

## 0.7.0

### Minor Changes

- [#21](https://github.com/inflowpayai/inflow-cli/pull/21)
  [`0127f1c`](https://github.com/inflowpayai/inflow-cli/commit/0127f1c37f72c1daab791dbf849c66431978ecae) Thanks
  [@nkavian](https://github.com/nkavian)! - Add `--bootstrap` and named-skill support to `--skill`, and project the web
  agent docs from the binary.
  - `--bootstrap` prints the agent setup guide (install, authenticate, load a playbook) - the same text served at
    https://inflowcli.ai/skill.md.
  - `--skill [name]` accepts an optional skill name (`--skill agentic-payments`, `--skill=agentic-payments`), defaulting
    to `agentic-payments`; unknown names exit 1 and list the available skills. Every `skills/<name>/SKILL.md` is
    embedded at build time.
  - Both flags are listed in `--help` global options.
  - `scripts/publish-skills.mjs` (wired into `build`/`release`) publishes the inflowcli.ai docroot from the binary:
    `skill.md` from `--bootstrap`, `llms.txt`/`llms-full.txt` from `--llms`/`--llms-full`, playbooks from
    `skills/*/SKILL.md`, and stamps the minimum Node version into the install scripts.
  - The npm `homepage`, skill metadata, and command descriptions now reference https://inflowcli.ai; user-facing strings
    are ASCII-only.

## 0.6.6

### Patch Changes

- [#19](https://github.com/inflowpayai/inflow-cli/pull/19)
  [`815b6a6`](https://github.com/inflowpayai/inflow-cli/commit/815b6a6e98415f421f9746b73bdef3333ad0894c) Thanks
  [@mnebliienko](https://github.com/mnebliienko)! - Propagate the terminal result of `mpp`/`x402` `pay` and `status` in
  agent mode.

  These commands delegate to async-generator pipelines that surface terminal failures as the generator's return value
  (`return c.error(...)`), not as a yielded chunk. The command wrappers consumed the delegate with a bare `yield*`,
  which forwards yielded chunks but drops the return value, so the wrapper returned `undefined`. In buffered agent
  output (`--format json`) the framework then took the success path and emitted `{ ok: true, data: [] }` with exit code
  0, swallowing errors such as `NO_FILTERED_MATCH`. The wrappers now `return yield*` the delegate, so the error envelope
  is emitted with a non-zero exit code.

## 0.6.5

### Patch Changes

- [#16](https://github.com/inflowpayai/inflow-cli/pull/16)
  [`5efbbbd`](https://github.com/inflowpayai/inflow-cli/commit/5efbbbd55054bc40346c44a211521c3d72ce20c1) Thanks
  [@mnebliienko](https://github.com/mnebliienko)! - Document per-surface skill and MCP installation, testing, and update
  flows, and accept assignment-form global boolean flags such as `--verbose=true`.

- [#18](https://github.com/inflowpayai/inflow-cli/pull/18)
  [`4c8ae86`](https://github.com/inflowpayai/inflow-cli/commit/4c8ae86527b8979236863f9960b65f8ec7f103ed) Thanks
  [@nkavian](https://github.com/nkavian)! - Add a top-level `inflow inspect <url>` command — a protocol-agnostic,
  read-only probe that detects MPP and x402 from a single 402 response.
  - `inflow inspect <url>` makes one unauthenticated probe and decodes both the MPP `WWW-Authenticate: Payment`
    challenges and the x402 `PAYMENT-REQUIRED` accepts from the same response. It carries only the probe-shape flags
    (`--method`, `--data`, `--header`); for filtered probes or full per-protocol detail, use `inflow mpp inspect` /
    `inflow x402 inspect`.
  - Agent shape (`--format json`): `{ outcome, url, method, detected, mpp[], x402[], warnings? }`. The `mpp` and `x402`
    arrays are always present (empty when a protocol is absent); `detected` lists the protocols that carry at least one
    usable entry, so a caller can choose the pay rail (MPP wins when both are present). The x402 `amount` is the
    seller's raw atomic units and `asset` is the full on-chain contract address / mint rendered verbatim — not a token
    symbol.
  - When the seller advertises MPP but no `inflow`-method challenge, the `NO_INFLOW_MATCH` warning and the human view
    name the methods the seller did offer (for example `tempo`) and the warning carries a structured `methods` array.
  - A 402 carrying neither protocol header reports `detected: []` with a `NO_PAYMENT_CHALLENGE` warning rather than
    failing; a present-but-undecodable header surfaces as a per-protocol warning.

  core (`@inflowpayai/inflow-core`): adds the `runCombinedInspectPipeline` flow and the `parseMppHeaderFromProbe` /
  `parseX402HeaderFromProbe` helpers shared by the per-protocol and combined inspects.

## 0.6.4

### Patch Changes

- [#14](https://github.com/inflowpayai/inflow-cli/pull/14)
  [`278209e`](https://github.com/inflowpayai/inflow-cli/commit/278209ec13f733c0eff88a7b39823a6da2468b85) Thanks
  [@nkavian](https://github.com/nkavian)! - Clear the pending device-auth record after a successful inline `auth login`.

  The inline (agent / `--interval`) device-login path persisted the new tokens but left `pendingDeviceAuth` in the
  config file. Because `composeAuthSnapshot` prefers a pending record over saved tokens, `auth status` would report
  `authenticated: false, pending: true` despite a successful login until the device code expired. `runAuthLogin` now
  calls `clearPendingDeviceAuth()` in the same success step that writes the tokens, so the record is dropped
  immediately.

## 0.6.3

### Patch Changes

- [#12](https://github.com/inflowpayai/inflow-cli/pull/12)
  [`8036cd1`](https://github.com/inflowpayai/inflow-cli/commit/8036cd1e37531cce85b2e21df4ab930827cc0cf0) Thanks
  [@nkavian](https://github.com/nkavian)! - Unify plugin install naming and keep `pnpm verify` idempotent.
  - Rename the Cursor and agents marketplaces to `inflow` (matching the Claude marketplace, the plugin, and the `inflow`
    binary), so the install target is `inflow@inflow` on every host.
  - Correct the README install command to `/plugin install inflow@inflow`, and note that `inflowpayai/inflow-cli` is
    only the GitHub repo slug.
  - Stamp the version in the manifest JSON files surgically (replace only the `version` value) instead of reserializing
    with `JSON.stringify`, which reflowed arrays one-element-per-line and fought Prettier. `build` no longer leaves
    manifests in a shape the next `format` rewrites, so the pipeline converges in one pass.

## 0.6.2

### Patch Changes

- [#10](https://github.com/inflowpayai/inflow-cli/pull/10)
  [`fa8d827`](https://github.com/inflowpayai/inflow-cli/commit/fa8d827e82dc556dddb2d39b7c450bcc715c1fb5) Thanks
  [@nkavian](https://github.com/nkavian)! - Fix the plugin bundle so the skill and MCP server actually load, and broaden
  host coverage.
  - Add `skills`, `.mcp.json`, and `assets` symlinks under `plugins/inflow/` so the per-plugin manifests' `./skills/`,
    `./.mcp.json`, and `./assets/` paths resolve (previously they pointed at nonexistent paths and the skill/MCP server
    never loaded).
  - Add a Cursor per-plugin manifest (`plugins/inflow/.cursor-plugin/plugin.json`), a Cursor marketplace entry
    (`.cursor-plugin/marketplace.json`), and an agents marketplace entry (`.agents/plugins/marketplace.json`).
  - Stamp the repo-root `package.json` and the new Cursor per-plugin manifest from the version-sync script.
  - Mention MPP alongside x402 in the Codex top-level manifest and Claude marketplace descriptions.
  - Document agent/plugin install paths in the README.

## 0.6.1

### Patch Changes

- [#8](https://github.com/inflowpayai/inflow-cli/pull/8)
  [`61c8a3b`](https://github.com/inflowpayai/inflow-cli/commit/61c8a3b956116cf09aae4f473cc1bad04ec6c074) Thanks
  [@nkavian](https://github.com/nkavian)! - Drop the removed `settlement` field from MPP receipt handling.
  `@inflowpayai/mpp`'s `MppReceipt` no longer carries `settlement` (amount/currency), so `mpp pay` no longer projects
  `amount`/`currency` into its settlement summary, the `mpp decode` receipt view no longer prints a settled amount, and
  the receipt discriminator now keys on `challengeId`.

## 0.6.0

### Minor Changes

- [#5](https://github.com/inflowpayai/inflow-cli/pull/5)
  [`2d56708`](https://github.com/inflowpayai/inflow-cli/commit/2d5670854392e0e7c6218ad327c6f9435ce971e1) Thanks
  [@nkavian](https://github.com/nkavian)! - Add Machine Payments Protocol (MPP) support.

  The CLI gains a new `mpp` command group — `pay`, `status`, `inspect`, `decode`, `cancel`, and `supported` — backed by
  new core flows (`mpp-pay`, `mpp-status`, `mpp-inspect`, `mpp-decode`, `mpp-cancel`, `mpp-supported`, and shared
  helpers). A `use-flow-exit` hook and `best-effort-cancel` util provide graceful cancellation on interrupt, and a
  programmatic MPP pay example is added to `@inflowpayai/inflow-core`. Also refreshes x402 flow internals, docs, plugin
  manifests, and the agentic-payments skill.

## 0.5.2

### Patch Changes

- [#2](https://github.com/inflowpayai/inflow-cli/pull/2)
  [`c1879a0`](https://github.com/inflowpayai/inflow-cli/commit/c1879a0a2a907ae469a779a5049996607cf0fef0) Thanks
  [@nkavian](https://github.com/nkavian)! - Fix CI test races and pnpm-only settings leaking into npm.
