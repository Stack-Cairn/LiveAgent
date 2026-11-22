#!/usr/bin/env bash
# Installs the Ubuntu 24.04 packages needed to build the Tauri desktop app and
# drive it through WebKitWebDriver under a virtual X server. Shared by the
# desktop E2E Docker image and the CI job so both run the same stack.
set -euo pipefail

SUDO=""
if [ "$(id -u)" -ne 0 ]; then SUDO="sudo"; fi

PACKAGES=(
  build-essential ca-certificates curl file git pkg-config procps unzip xz-utils
  clang libclang-dev mold protobuf-compiler
  libssl-dev libdbus-1-dev libglib2.0-dev libgtk-3-dev libwebkit2gtk-4.1-dev
  libayatana-appindicator3-dev librsvg2-dev libxdo-dev
  webkit2gtk-driver xvfb xauth dbus dbus-x11 at-spi2-core
  fonts-dejavu-core fonts-noto-cjk
)

export DEBIAN_FRONTEND=noninteractive
APT_OPTS=(-o Acquire::Retries=5 -o Acquire::http::Timeout=60)
$SUDO apt-get "${APT_OPTS[@]}" update -qq
# Mirrors occasionally drop connections mid-download; already fetched archives
# stay in the apt cache, so a retry only fetches what is still missing.
for attempt in 1 2 3 4; do
  if $SUDO apt-get "${APT_OPTS[@]}" install -y --no-install-recommends "${PACKAGES[@]}"; then
    break
  fi
  if [ "$attempt" -eq 4 ]; then exit 1; fi
  echo "apt-get install failed (attempt $attempt), retrying" >&2
  sleep $((attempt * 5))
done

if [ "${E2E_CLEAN_APT_LISTS:-0}" = "1" ]; then
  $SUDO rm -rf /var/lib/apt/lists/*
fi

pkg-config --exists gtk+-3.0 webkit2gtk-4.1
command -v WebKitWebDriver >/dev/null
