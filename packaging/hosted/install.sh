#!/bin/sh
# InFlow CLI installer - served at https://inflowcli.ai/install.sh
# Usage: curl -fsSL https://inflowcli.ai/install.sh | sh
set -eu

repository='inflowpayai/inflow-cli'
install_url='https://inflowcli.ai/'
linux_signing_fingerprint='508C278E08BED465D79E20F71D0FCE31F33234BA'
macos_team_identifier='B96U57DTR2'
temporary_directory=''

say() {
  printf '%s\n' "[inflow] $*"
}

fail() {
  printf '%s\n' "[inflow] $*" >&2
  exit 1
}

cleanup() {
  if [ -n "$temporary_directory" ]; then
    rm -rf "$temporary_directory"
  fi
}

download() {
  curl --fail --location --retry 3 --retry-delay 2 --silent --show-error \
    --header 'User-Agent: inflow-installer' --output "$2" "$1"
}

privileged() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    fail 'Installation requires root privileges. Install sudo or run this installer as root.'
  fi
}

resolve_release() {
  release_tag="${INFLOW_RELEASE_TAG:-}"
  if [ -z "$release_tag" ]; then
    release_json="$(curl --fail --location --silent --show-error \
      --header 'User-Agent: inflow-installer' "https://api.github.com/repos/$repository/releases/latest")"
    release_tag="$(printf '%s\n' "$release_json" |
      sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\(v[^"]*\)".*/\1/p' |
      head -n 1)"
  fi
  case "$release_tag" in
    v[0-9]*) ;;
    *) fail "Could not resolve the latest signed InFlow release. Install instructions: $install_url" ;;
  esac
  version="${release_tag#v}"
  release_base_url="${INFLOW_RELEASE_BASE_URL:-https://github.com/$repository/releases/download/$release_tag}"
}

checksum() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -c "$1"
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 -c "$1"
  else
    fail 'SHA-256 verification requires sha256sum or shasum.'
  fi
}

fingerprint() {
  gpg --batch --with-colons --show-keys "$1" |
    awk -F: '$1 == "fpr" { print toupper($10); exit }'
}

install_linux() {
  command -v curl >/dev/null 2>&1 || fail 'Installation requires curl.'
  command -v gpg >/dev/null 2>&1 || fail 'OpenPGP verification requires gpg.'
  command -v gpgv >/dev/null 2>&1 || fail 'OpenPGP verification requires gpgv.'

  case "$(uname -m)" in
    aarch64 | arm64)
      debian_architecture='arm64'
      rpm_architecture='aarch64'
      ;;
    x86_64 | amd64)
      debian_architecture='amd64'
      rpm_architecture='x86_64'
      ;;
    *) fail "Unsupported Linux architecture: $(uname -m)" ;;
  esac

  if command -v apt-get >/dev/null 2>&1; then
    asset="inflow_${version}_${debian_architecture}.deb"
    package_manager='apt'
  elif command -v dnf >/dev/null 2>&1; then
    asset="inflow-${version}-1.${rpm_architecture}.rpm"
    package_manager='dnf'
  else
    fail 'Installation requires a supported Debian/Ubuntu or Fedora/RHEL system with systemd.'
  fi

  say "Downloading InFlow $version for Linux $(uname -m)."
  download "$release_base_url/$asset" "$temporary_directory/$asset"
  download "$release_base_url/SHA256SUMS" "$temporary_directory/SHA256SUMS"
  download "$release_base_url/SHA256SUMS.asc" "$temporary_directory/SHA256SUMS.asc"
  download "$release_base_url/inflow-linux-signing-key.asc" "$temporary_directory/inflow-linux-signing-key.asc"

  actual_fingerprint="$(fingerprint "$temporary_directory/inflow-linux-signing-key.asc")"
  [ "$actual_fingerprint" = "$linux_signing_fingerprint" ] ||
    fail 'The Linux release signing-key fingerprint is invalid.'
  gpg --batch --yes --dearmor --output "$temporary_directory/inflow-linux-signing-key.gpg" \
    "$temporary_directory/inflow-linux-signing-key.asc"
  gpgv --keyring "$temporary_directory/inflow-linux-signing-key.gpg" \
    "$temporary_directory/SHA256SUMS.asc" "$temporary_directory/SHA256SUMS" ||
    fail 'The Linux release signature is invalid.'
  awk -v asset="$asset" '$2 == asset { print; found = 1 } END { if (!found) exit 1 }' \
    "$temporary_directory/SHA256SUMS" > "$temporary_directory/$asset.sha256" ||
    fail 'The Linux release manifest does not contain the selected package.'
  (
    cd "$temporary_directory"
    checksum "$asset.sha256"
  )

  if [ "$package_manager" = 'apt' ]; then
    privileged env DEBIAN_FRONTEND=noninteractive apt-get install --yes "$temporary_directory/$asset"
  else
    privileged dnf install --assumeyes "$temporary_directory/$asset"
  fi
  command -v inflow >/dev/null 2>&1 || fail 'InFlow was installed but is not available on PATH.'
  say "Installed $(inflow --version)."
  say "Run 'inflow vault unlock' in a terminal before using credential-dependent commands."
}

install_macos() {
  command -v curl >/dev/null 2>&1 || fail 'Installation requires curl.'
  command -v shasum >/dev/null 2>&1 || fail 'Installation requires shasum.'
  command -v codesign >/dev/null 2>&1 || fail 'Installation requires codesign.'
  command -v spctl >/dev/null 2>&1 || fail 'Installation requires spctl.'

  case "$(uname -m)" in
    arm64) artifact_architecture='arm64' ;;
    x86_64) artifact_architecture='x64' ;;
    *) fail "Unsupported macOS architecture: $(uname -m)" ;;
  esac

  asset="inflow-${version}-darwin-${artifact_architecture}.zip"
  download "$release_base_url/$asset" "$temporary_directory/$asset"
  download "$release_base_url/$asset.sha256" "$temporary_directory/$asset.sha256"
  (
    cd "$temporary_directory"
    shasum -a 256 -c "$asset.sha256"
  )

  extract_directory="$temporary_directory/extract"
  mkdir -p "$extract_directory"
  ditto -x -k "$temporary_directory/$asset" "$extract_directory"
  application_path="$(find "$extract_directory" -maxdepth 3 -name InFlow.app -type d -print -quit)"
  [ -n "$application_path" ] || fail 'Downloaded archive did not contain InFlow.app.'

  codesign --verify --deep --strict --verbose=2 "$application_path"
  signature_details="$(codesign -d --verbose=4 "$application_path" 2>&1)"
  printf '%s\n' "$signature_details" | grep -q "^TeamIdentifier=$macos_team_identifier$" ||
    fail 'The InFlow application signing identity is invalid.'
  spctl --assess --type execute --verbose=2 "$application_path"

  install_root="${INFLOW_INSTALL_DIR:-$HOME/.local/share/inflow}"
  bin_root="${INFLOW_BIN_DIR:-$HOME/.local/bin}"
  target_application="$install_root/InFlow.app"
  target_binary="$bin_root/inflow"
  mkdir -p "$install_root" "$bin_root"
  rm -rf "$target_application"
  mv "$application_path" "$target_application"
  rm -f "$target_binary"
  ln -s "$target_application/Contents/MacOS/inflow" "$target_binary"

  say "Installed InFlow $version to $target_application."
  say "Linked $target_binary."
  case ":$PATH:" in
    *":$bin_root:"*) say 'Run: inflow --version' ;;
    *)
      say "$bin_root is not on PATH. Add it to your shell profile or run:"
      say "  $target_binary --version"
      ;;
  esac
}

uninstall_linux() {
  if command -v apt-get >/dev/null 2>&1; then
    privileged env DEBIAN_FRONTEND=noninteractive apt-get remove --yes inflow
  elif command -v dnf >/dev/null 2>&1; then
    privileged dnf remove --assumeyes inflow
  else
    fail 'Uninstall requires apt-get or dnf.'
  fi
  say 'InFlow was uninstalled. Encrypted vault data was preserved.'
}

purge_linux() {
  if command -v apt-get >/dev/null 2>&1; then
    privileged env DEBIAN_FRONTEND=noninteractive apt-get purge --yes inflow
  elif command -v dnf >/dev/null 2>&1; then
    privileged dnf remove --assumeyes inflow
  else
    fail 'Purge requires apt-get or dnf.'
  fi
  privileged rm -rf /var/lib/inflow /var/lib/inflow-broker /run/inflow
  say 'InFlow and its system vault data were removed.'
}

uninstall_macos() {
  install_root="${INFLOW_INSTALL_DIR:-$HOME/.local/share/inflow}"
  bin_root="${INFLOW_BIN_DIR:-$HOME/.local/bin}"
  rm -f "$bin_root/inflow"
  rm -rf "$install_root/InFlow.app"
  say "Removed InFlow from $install_root/InFlow.app."
  say "Removed $bin_root/inflow."
}

operating_system="$(uname -s)"
action="${1:-install}"
case "$action" in
  install | --uninstall | --purge) ;;
  -h | --help)
    printf '%s\n' 'Usage: install.sh [--uninstall|--purge]'
    exit 0
    ;;
  *) fail 'Usage: install.sh [--uninstall|--purge]' ;;
esac

case "$operating_system:$action" in
  Darwin:install | Linux:install)
    resolve_release
    temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/inflow-install.XXXXXX")"
    trap cleanup EXIT HUP INT TERM
    if [ "$operating_system" = 'Darwin' ]; then
      install_macos
    else
      install_linux
    fi
    ;;
  Darwin:--uninstall | Darwin:--purge) uninstall_macos ;;
  Linux:--uninstall) uninstall_linux ;;
  Linux:--purge) purge_linux ;;
  MINGW*:*) fail 'Use PowerShell on Windows: iwr -useb https://inflowcli.ai/install.ps1 | iex' ;;
  MSYS*:*) fail 'Use PowerShell on Windows: iwr -useb https://inflowcli.ai/install.ps1 | iex' ;;
  CYGWIN*:*) fail 'Use PowerShell on Windows: iwr -useb https://inflowcli.ai/install.ps1 | iex' ;;
  *) fail "Unsupported operating system: $operating_system. Install instructions: $install_url" ;;
esac
