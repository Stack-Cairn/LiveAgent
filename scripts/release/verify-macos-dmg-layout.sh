#!/usr/bin/env bash
# Mounts a Tauri-built DMG read-only and asserts that the Finder installer layout
# (background, window size, icon positions) was actually baked into it.
#
# tauri-bundler applies that layout by driving Finder through AppleScript, and it
# persists as a `.DS_Store` at the DMG root. When the bundler sees `CI=true` it passes
# `--skip-jenkins` to bundle_dmg and silently skips that step, yielding a DMG that opens
# as a plain white Finder window. Release builds opt back in via
# `TAURI_BUNDLER_DMG_IGNORE_CI=true`; this guard makes sure a regression never ships.
set -euo pipefail

usage() {
  echo "Usage: $0 <dmg-path> [app-name]" >&2
}

fail() {
  echo "verify-macos-dmg-layout: $*" >&2
  exit 1
}

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  usage
  exit 2
fi

for command_name in hdiutil mktemp find; do
  command -v "$command_name" >/dev/null 2>&1 || fail "missing required command: $command_name"
done

dmg_path="$1"
app_name="${2:-LiveAgent}"
test -f "$dmg_path" || fail "DMG not found: $dmg_path"

mount_point="$(mktemp -d "${TMPDIR:-/tmp}/liveagent-dmg-verify.XXXXXX")"
mounted=0
cleanup() {
  if [ "$mounted" -eq 1 ]; then
    hdiutil detach "$mount_point" -quiet -force >/dev/null 2>&1 || true
  fi
  rmdir -- "$mount_point" 2>/dev/null || true
}
trap cleanup EXIT

hdiutil attach "$dmg_path" -readonly -nobrowse -noautoopen -noverify -mountpoint "$mount_point" >/dev/null
mounted=1

failures=0
check() {
  local description="$1"
  shift
  if "$@"; then
    echo "  ok    $description"
  else
    echo "  FAIL  $description"
    failures=$((failures + 1))
  fi
}

has_background_image() {
  find "$1/.background" -maxdepth 1 -type f -print -quit 2>/dev/null | grep -q .
}

echo "Verifying Finder layout of $dmg_path"
check "$app_name.app bundle present" test -d "$mount_point/$app_name.app"
check "Applications symlink present" test -L "$mount_point/Applications"
check ".background/ image present" has_background_image "$mount_point"
check ".DS_Store present (Finder window size, background, icon positions)" test -s "$mount_point/.DS_Store"

if [ "$failures" -ne 0 ]; then
  fail "$failures check(s) failed. The DMG would open as a plain Finder window without the configured background and icon layout.
  When building on CI, make sure TAURI_BUNDLER_DMG_IGNORE_CI=true is set: tauri-bundler skips the Finder AppleScript whenever CI=true.
  See https://github.com/tauri-apps/tauri/issues/1731 and Stack-Cairn/LiveAgent#558."
fi

echo "DMG Finder layout verified: $dmg_path"
