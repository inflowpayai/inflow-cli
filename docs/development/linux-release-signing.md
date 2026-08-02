# Linux Release Signing

The Linux production trust root is an offline OpenPGP primary certification key. GitHub receives only an automation
signing subkey. GitHub Releases is the initial production origin for versioned Linux assets; native APT and RPM
repositories are outside this baseline.

## Timing

Create the production keys after the disposable-key workflow passes and before the first production workflow run. Do not
create production keys merely to test the workflow. Do not generate or import the primary key in a development
workspace, ordinary daily-use keyring, GitHub runner, or cloud shell.

## Offline key generation

Use a clean offline computer started from trusted media. Disconnect networking before key generation. Attach the first
encrypted backup device and create a dedicated GnuPG home on it. Generate the primary key, capture its fingerprint, add
the signing subkey, and create the initial exports:

```sh
export GNUPGHOME=/path/to/encrypted-device/inflow-linux-gnupg
mkdir -m 0700 "$GNUPGHOME"
gpg --quick-generate-key 'InFlow Linux Release <support@inflowpay.ai>' rsa4096 cert 0
PRIMARY_FINGERPRINT="$(
  gpg --batch --with-colons --fingerprint \
    'InFlow Linux Release <support@inflowpay.ai>' |
    awk -F: '$1 == "fpr" { print $10; exit }'
)"
printf 'Primary fingerprint: %s\n' "$PRIMARY_FINGERPRINT"
gpg --quick-add-key "$PRIMARY_FINGERPRINT" rsa4096 sign 2y
gpg --armor --export "$PRIMARY_FINGERPRINT" > inflow-linux-signing-key.asc
gpg --armor --export-secret-keys "$PRIMARY_FINGERPRINT" > inflow-linux-primary-backup.asc
gpg --armor --export-secret-subkeys "$PRIMARY_FINGERPRINT" > inflow-linux-automation-subkey.asc
gpg --armor --output inflow-linux-revocation.asc --gen-revoke "$PRIMARY_FINGERPRINT"
```

For the revocation reason, select `0` (`No reason specified`), leave the optional description empty, and confirm
creation. Creating the certificate does not revoke the key. Revocation occurs only if the certificate is imported and
the resulting revoked public key is published.

Record the fingerprint on a second offline medium. Store two encrypted copies of the complete primary backup in separate
physical locations. Store the revocation certificate separately from both primary-key backups. Use a strong primary-key
passphrase and never remove protection from either complete primary backup.

## Automation-only export

Keep the key-custody computer offline. Re-establish the primary keyring location and fingerprint if the original shell
session ended:

```sh
export GNUPGHOME=/path/to/encrypted-device/inflow-linux-gnupg
PRIMARY_FINGERPRINT="$(
  gpg --batch --with-colons --fingerprint \
    'InFlow Linux Release <support@inflowpay.ai>' |
    awk -F: '$1 == "fpr" { print $10; exit }'
)"
printf 'Primary fingerprint: %s\n' "$PRIMARY_FINGERPRINT"
test -s inflow-linux-automation-subkey.asc
```

Import the protected automation-subkey export into a separate GnuPG home on encrypted removable storage:

```sh
export AUTOMATION_GNUPGHOME=/path/to/encrypted-device/inflow-linux-automation-gnupg
mkdir -m 0700 "$AUTOMATION_GNUPGHOME"
GNUPGHOME="$AUTOMATION_GNUPGHOME" \
  gpg --import inflow-linux-automation-subkey.asc
GNUPGHOME="$AUTOMATION_GNUPGHOME" \
  gpg --edit-key "$PRIMARY_FINGERPRINT"
```

At the `gpg>` prompt:

1. Enter `passwd`.
2. Enter the current subkey passphrase.
3. Leave the new passphrase empty.
4. Confirm the warning about an empty passphrase.
5. Enter `quit` after GnuPG reports that the passphrase changed.

Export that isolated copy to encrypted transfer storage:

```sh
GNUPGHOME="$AUTOMATION_GNUPGHOME" \
  gpg --armor --export-secret-subkeys "$PRIMARY_FINGERPRINT" \
  > /path/to/encrypted-transfer/inflow-linux-automation-subkey-unencrypted.asc
test -s /path/to/encrypted-transfer/inflow-linux-automation-subkey-unencrypted.asc
```

Confirm that the primary line is marked `sec#` and the signing-subkey line is marked `ssb`. The `#` means the primary
secret key is unavailable:

```sh
GNUPGHOME="$AUTOMATION_GNUPGHOME" \
  gpg --list-secret-keys "$PRIMARY_FINGERPRINT"
```

Do not continue unless those markers are present.

## GitHub environment

Move only `inflow-linux-automation-subkey-unencrypted.asc` and the recorded public fingerprint to a networked
administration computer. Do not reconnect the offline key-custody computer.

Authenticate GitHub CLI as a repository administrator and create the environment:

```sh
gh auth status
gh api --method PUT \
  repos/inflowpayai/inflow-cli/environments/linux-production \
  >/dev/null
```

In repository settings, configure `linux-production` before uploading the secret:

- Restrict deployments to release tags.
- Require the sole release operator's approval.
- Permit the initiating operator to approve the deployment.
- Do not allow administrator bypass.

## GitHub entries

Run these commands from the directory containing the unencrypted automation export:

```sh
set -o pipefail
export PRIMARY_FINGERPRINT='PASTE_THE_RECORDED_PRIMARY_FINGERPRINT'
test -s inflow-linux-automation-subkey-unencrypted.asc

base64 < inflow-linux-automation-subkey-unencrypted.asc |
  tr -d '\n' |
  gh secret set LINUX_OPENPGP_SIGNING_SUBKEY_BASE64 \
    --env linux-production \
    --repo inflowpayai/inflow-cli

printf '%s' "$PRIMARY_FINGERPRINT" |
  gh variable set LINUX_OPENPGP_SIGNING_FINGERPRINT \
    --env linux-production \
    --repo inflowpayai/inflow-cli
```

Verify both entries. GitHub lists the secret name but does not reveal its value:

```sh
gh secret list --env linux-production --repo inflowpayai/inflow-cli
gh variable get LINUX_OPENPGP_SIGNING_FINGERPRINT \
  --env linux-production \
  --repo inflowpayai/inflow-cli
```

Remove the unencrypted transfer copy from the networked administration computer after GitHub confirms the secret.

The private primary key and revocation certificate must not be stored in GitHub secrets, Actions artifacts, repository
files, release assets, password managers synchronized to daily-use machines, or this workspace.

## Production release

Create the version tag from the reviewed release commit, then dispatch `native-release.yml` from that tag. Immutable
releases must be enabled in the repository before the workflow runs. The repository variable records the release
operator's authenticated check because GitHub requires repository administration permission to read this setting and
does not grant that permission to a workflow token.

```sh
VERSION="$(node -p "require('./packages/cli/package.json').version")"
TAG="v$VERSION"
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
test "$(gh api repos/inflowpayai/inflow-cli/immutable-releases --jq '.enabled')" = 'true'
gh variable set IMMUTABLE_RELEASES_ENABLED --repo inflowpayai/inflow-cli --body true
git tag "$TAG"
git push origin "$TAG"
gh workflow run native-release.yml \
  --repo inflowpayai/inflow-cli \
  --ref "$TAG" \
  -f publish=true \
  -f version="$VERSION"
```

Use `-f publish=false` to run production signing, notarization, staging, and complete asset verification without
creating a GitHub Release or updating Homebrew.

The protected job imports the automation subkey, compares the complete expected fingerprint, signs both RPM packages,
creates and signs `SHA256SUMS`, verifies every signature, attests the final package bytes, renders an installer pinned
to the fingerprint, and stages the versioned assets. The native release workflow publishes only after the macOS and
Linux stages pass and the combined asset inventory and GitHub digests match.

Before the first production release, create a temporary `v*` tag for the reviewed commit and dispatch the verification
mode. This mode uses read-only repository permissions, requires approval through `linux-production`, rejects an export
with a usable primary secret key, signs and verifies both architectures, installs from the signed assets, and publishes
nothing:

```sh
git tag v0.9.0-signing-test.1 REVIEWED_COMMIT
git push origin v0.9.0-signing-test.1
gh workflow run linux-release.yml \
  --repo inflowpayai/inflow-cli \
  --ref v0.9.0-signing-test.1 \
  -f verify_production_signing=true
```

Delete the temporary local and remote tag after the verification workflow passes:

```sh
git tag --delete v0.9.0-signing-test.1
git push origin --delete v0.9.0-signing-test.1
```

The installer downloads the selected package, `SHA256SUMS`, `SHA256SUMS.asc`, and the public key. It compares the
public-key fingerprint with its pinned fingerprint, verifies the manifest with `gpgv`, selects the exact package entry,
and verifies the package checksum before installation.

## Review, replacement, and revocation

Review access, backups, the published fingerprint, and the signing subkey annually. Generate a replacement signing
subkey on the offline machine approximately 90 days before the current subkey expires. Publish a release containing the
updated public key before using the replacement subkey. Every Linux release publishes `inflow-linux-signing-key.asc`;
the stable recovery URL is
`https://github.com/inflowpayai/inflow-cli/releases/latest/download/inflow-linux-signing-key.asc`.

If the automation subkey may be compromised:

1. Disable the `linux-production` environment and stop Linux publication.
2. Use the offline primary key to revoke the automation subkey.
3. Generate a replacement signing subkey.
4. Publish the updated public key in a new GitHub Release and publish the incident notice through a GitHub Security
   Advisory and that release's notes.
5. Replace the GitHub environment secret and verify its fingerprint.
6. Rebuild affected releases from reviewed source; do not merely re-sign existing untrusted artifacts.

If the offline primary key may be compromised, stop publication and establish a new trust root. Existing installers must
not silently accept that replacement fingerprint.
