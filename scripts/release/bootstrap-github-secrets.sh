#!/usr/bin/env bash
set -euo pipefail

if [ -z "${CERT_DIR:-}" ]; then
  if [ -d "$HOME/Personal/cert" ]; then
    CERT_DIR="$HOME/Personal/cert"
  else
    CERT_DIR="$HOME/Downloads/cert"
  fi
fi
P12_PATH="${P12_PATH:-$CERT_DIR/developer_id_application.p12}"
APP_PASSWORD_FILE="${APP_PASSWORD_FILE:-$CERT_DIR/app key.md}"
APPLE_SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:-Developer ID Application: wenlin fei (UU94JSVAA9)}"
APPLE_ID="${APPLE_ID:-apple@stackcairn.io}"
APPLE_TEAM_ID="${APPLE_TEAM_ID:-UU94JSVAA9}"
KEYCHAIN_PATH="${KEYCHAIN_PATH:-$HOME/Library/Keychains/login.keychain-db}"
BOOTSTRAP_APPLE_SECRETS="${BOOTSTRAP_APPLE_SECRETS:-1}"

if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI is required. Install it and authenticate with: gh auth login" >&2
  exit 1
fi

bootstrap_apple_release_secrets() {
  if [ -z "${APPLE_APP_SPECIFIC_PASSWORD:-}" ]; then
    if [ ! -f "$APP_PASSWORD_FILE" ]; then
      echo "missing Apple app-specific password file: $APP_PASSWORD_FILE" >&2
      echo "Set APPLE_APP_SPECIFIC_PASSWORD directly, or set APP_PASSWORD_FILE to the file that contains it." >&2
      exit 1
    fi
    APPLE_APP_SPECIFIC_PASSWORD="$(tr -d '\n\r' < "$APP_PASSWORD_FILE")"
  fi

  if [ ! -f "$P12_PATH" ]; then
    if ! command -v security >/dev/null 2>&1; then
      echo "missing p12 file: $P12_PATH" >&2
      echo "security CLI is required to export it automatically from Keychain" >&2
      exit 1
    fi
    if [ -z "${APPLE_CERTIFICATE_PASSWORD:-}" ]; then
      APPLE_CERTIFICATE_PASSWORD="$(openssl rand -base64 32)"
    fi
    mkdir -p "$(dirname "$P12_PATH")"
    security find-identity -v -p codesigning "$KEYCHAIN_PATH" | grep -F -- "$APPLE_SIGNING_IDENTITY" >/dev/null || {
      echo "signing identity not found in keychain: $APPLE_SIGNING_IDENTITY" >&2
      echo "Checked keychain: $KEYCHAIN_PATH" >&2
      echo "Run: security find-identity -v -p codesigning \"$KEYCHAIN_PATH\"" >&2
      exit 1
    }
    if ! security export \
      -k "$KEYCHAIN_PATH" \
      -t identities \
      -f pkcs12 \
      -P "$APPLE_CERTIFICATE_PASSWORD" \
      -o "$P12_PATH" >/dev/null; then
      cat >&2 <<EOF
failed to export Developer ID identity from Keychain.

This usually means the private key is missing, non-exportable, or macOS denied export access.
Fallback:
  1. Open Keychain Access and verify the Developer ID Application certificate has a private key.
  2. Export that identity manually as a .p12 file to: $P12_PATH
  3. Re-run with APPLE_CERTIFICATE_PASSWORD set to the .p12 export password.
EOF
      exit 1
    fi
    chmod 600 "$P12_PATH"
    echo "Exported Developer ID identity to $P12_PATH"
  elif [ -z "${APPLE_CERTIFICATE_PASSWORD:-}" ]; then
    echo "APPLE_CERTIFICATE_PASSWORD is required for the existing exported .p12" >&2
    exit 1
  fi

  P12_BASE64="$(base64 < "$P12_PATH" | tr -d '\n')"

  printf '%s' "$P12_BASE64" | gh secret set APPLE_CERTIFICATE_P12_BASE64
  printf '%s' "$APPLE_CERTIFICATE_PASSWORD" | gh secret set APPLE_CERTIFICATE_PASSWORD
  printf '%s' "$APPLE_SIGNING_IDENTITY" | gh secret set APPLE_SIGNING_IDENTITY
  printf '%s' "$APPLE_ID" | gh secret set APPLE_ID
  printf '%s' "$APPLE_TEAM_ID" | gh secret set APPLE_TEAM_ID
  printf '%s' "$APPLE_APP_SPECIFIC_PASSWORD" | gh secret set APPLE_APP_SPECIFIC_PASSWORD
}

case "$BOOTSTRAP_APPLE_SECRETS" in
  1|true|TRUE|yes|YES)
    bootstrap_apple_release_secrets
    ;;
  0|false|FALSE|no|NO)
    echo "Skipping Apple release secrets because BOOTSTRAP_APPLE_SECRETS=$BOOTSTRAP_APPLE_SECRETS"
    ;;
  *)
    echo "BOOTSTRAP_APPLE_SECRETS must be 1 or 0, got: $BOOTSTRAP_APPLE_SECRETS" >&2
    exit 1
    ;;
esac

echo "GitHub release secrets updated."
