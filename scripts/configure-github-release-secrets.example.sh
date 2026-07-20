#!/usr/bin/env bash
set -euo pipefail

repository="inflowpayai/inflow-cli"

certificate_p12_path="REPLACE_WITH_PATH_TO_EXPORTED_DEVELOPER_ID_APPLICATION_P12"
certificate_p12_password="REPLACE_WITH_PASSWORD_USED_WHEN_EXPORTING_THE_P12"
notary_apple_id="REPLACE_WITH_APPLE_ID_EMAIL_USED_FOR_NOTARIZATION"
notary_app_specific_password="REPLACE_WITH_APP_SPECIFIC_PASSWORD_FROM_ACCOUNT_APPLE_COM"
notary_team_id="B96U57DTR2"
homebrew_tap_app_client_id="REPLACE_WITH_GITHUB_APP_CLIENT_ID"
homebrew_tap_app_private_key_path="REPLACE_WITH_PATH_TO_GITHUB_APP_PRIVATE_KEY_PEM"

require_value() {
  local name="$1"
  local value="$2"
  if [[ -z "$value" || "$value" == REPLACE_WITH_* ]]; then
    echo "Missing value for $name" >&2
    exit 1
  fi
}

require_value certificate_p12_path "$certificate_p12_path"
require_value certificate_p12_password "$certificate_p12_password"
require_value notary_apple_id "$notary_apple_id"
require_value notary_app_specific_password "$notary_app_specific_password"
require_value notary_team_id "$notary_team_id"
require_value homebrew_tap_app_client_id "$homebrew_tap_app_client_id"
require_value homebrew_tap_app_private_key_path "$homebrew_tap_app_private_key_path"

if [[ ! -f "$certificate_p12_path" ]]; then
  echo "Certificate file not found: $certificate_p12_path" >&2
  exit 1
fi

if [[ ! -f "$homebrew_tap_app_private_key_path" ]]; then
  echo "GitHub App private key file not found: $homebrew_tap_app_private_key_path" >&2
  exit 1
fi

certificate_base64="$(base64 -i "$certificate_p12_path" | tr -d '\n')"

gh secret set APPLE_DEVELOPER_ID_APPLICATION_CERTIFICATE_BASE64 --repo "$repository" --body "$certificate_base64"
gh secret set APPLE_DEVELOPER_ID_APPLICATION_CERTIFICATE_PASSWORD --repo "$repository" --body "$certificate_p12_password"
gh secret set APPLE_NOTARY_APPLE_ID --repo "$repository" --body "$notary_apple_id"
gh secret set APPLE_NOTARY_APP_SPECIFIC_PASSWORD --repo "$repository" --body "$notary_app_specific_password"
gh secret set APPLE_NOTARY_TEAM_ID --repo "$repository" --body "$notary_team_id"
gh secret set HOMEBREW_TAP_APP_PRIVATE_KEY --repo "$repository" < "$homebrew_tap_app_private_key_path"

gh variable set HOMEBREW_TAP_APP_CLIENT_ID --repo "$repository" --body "$homebrew_tap_app_client_id"

gh secret list --repo "$repository"
gh variable list --repo "$repository"
