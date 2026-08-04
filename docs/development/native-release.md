# Native Release Automation

Production releases use the `native release` GitHub Actions workflow. Create `v<version>` from the reviewed release
commit, then dispatch the workflow from that tag with an explicit `mode` input. The workflow derives the package version
from the selected tag; selecting a branch is rejected:

- `preflight` signs, notarizes, stages, and verifies the complete asset set without creating a GitHub Release.
- `draft` creates and verifies an unpublished draft, then deletes it.
- `publish` creates and verifies the draft, publishes it, and updates Homebrew and WinGet.

The workflow requires immutable GitHub Releases and publishes only after macOS, Windows, and Linux succeed. The
standalone platform workflows cannot publish a GitHub Release. They provide dry runs and protected signing checks;
production artifacts enter the combined release only through `native release`.

## macOS

The `macos release` workflow builds Apple Silicon and Intel application bundles, signs their nested code, notarizes and
staples them, renders and audits the Homebrew Cask, and stages the verified artifacts for the combined release.

Production runs require these repository secrets:

- `APPLE_DEVELOPER_ID_APPLICATION_CERTIFICATE_BASE64`
- `APPLE_DEVELOPER_ID_APPLICATION_CERTIFICATE_PASSWORD`
- `APPLE_NOTARY_APPLE_ID`
- `APPLE_NOTARY_APP_SPECIFIC_PASSWORD`
- `APPLE_NOTARY_TEAM_ID`
- `HOMEBREW_TAP_APP_PRIVATE_KEY`

They also require the `HOMEBREW_TAP_APP_CLIENT_ID` repository variable. After the complete native release is public, the
generated Cask is pushed to `inflowpayai/homebrew-tap`.

## Windows

The `windows release` workflow builds x64 and ARM64 payloads on their native architectures. Production signing uses
Microsoft Artifact Signing in this order:

1. Build the unsigned executable on its native architecture.
2. Sign `inflow.exe` on the supported x64 signing runner.
3. Build the architecture-specific MSI around the signed executable.
4. Sign the MSI.
5. Verify both Authenticode chains, publishers, and timestamps.
6. Render the checksums, hosted PowerShell installer, and WinGet manifests from the signed MSI files.

Use a protected GitHub environment named `windows-production`, require deployment approval, restrict it to release tags,
and configure these environment variables:

- `AZURE_ARTIFACT_SIGNING_CLIENT_ID`
- `AZURE_ARTIFACT_SIGNING_TENANT_ID`
- `AZURE_ARTIFACT_SIGNING_SUBSCRIPTION_ID`
- `AZURE_ARTIFACT_SIGNING_ENDPOINT`
- `AZURE_ARTIFACT_SIGNING_ACCOUNT`
- `AZURE_ARTIFACT_SIGNING_PROFILE`
- `AZURE_ARTIFACT_SIGNING_SUBJECT`

The Azure application uses an OpenID Connect federated credential scoped to the `windows-production` GitHub environment
and has the `Artifact Signing Certificate Profile Signer` role on the certificate profile. Do not create or store an
Azure client secret or certificate private key in GitHub.

The combined workflow verifies both signed MSI files before publishing. It then publishes the rendered
`InFlowPayAI.InFlow` manifests to the WinGet submission path and deploys the rendered `install.ps1` without altering its
signed-artifact metadata.

## Linux

The `linux release` workflow builds native AMD64 and ARM64 archives, Debian packages, and RPM packages. Pull requests
use a disposable OpenPGP key to sign a consolidated `SHA256SUMS` release manifest, sign both RPM packages, verify the
result, reject modified metadata and packages, and install through the rendered Linux installer.

Production runs use the protected `linux-production` GitHub environment. The environment permits approval by the
initiating sole release operator, is restricted to release tags, and contains only the exportable automation signing
subkey:

- Environment secret: `LINUX_OPENPGP_SIGNING_SUBKEY_BASE64`
- Environment variable: `LINUX_OPENPGP_SIGNING_FINGERPRINT`

The primary certification key remains offline and has no expiration. The automation signing subkey has a two-year
lifetime, is reviewed annually, and is replaced approximately 90 days before expiration. The native release workflow
signs and verifies the Linux assets before they enter the combined draft release.

See the [Linux release signing guide](./linux-release-signing.md) for the offline key ceremony, GitHub environment
setup, release process, and recovery procedure.
