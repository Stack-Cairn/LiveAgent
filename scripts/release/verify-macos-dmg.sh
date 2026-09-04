#!/usr/bin/env bash

set -euo pipefail

dmg_path="${1:?usage: verify-macos-dmg.sh /path/to/LiveAgent.dmg}"
if [[ ! -f "$dmg_path" ]]; then
  echo "macOS DMG not found: $dmg_path" >&2
  exit 1
fi

mount_path="$(mktemp -d -t liveagent-dmg-verify.XXXXXX)"
device_name=""

cleanup() {
  set +e
  if [[ -n "$device_name" ]]; then
    hdiutil detach "$device_name" >/dev/null
  fi
  rmdir "$mount_path" 2>/dev/null
}
trap cleanup EXIT

attach_output="$(hdiutil attach -readonly -nobrowse -noautoopen -mountpoint "$mount_path" "$dmg_path")"
device_name="$(printf '%s\n' "$attach_output" | awk '/^\/dev\// { print $1; exit }')"
if [[ -z "$device_name" ]]; then
  echo "Unable to determine mounted device for: $dmg_path" >&2
  exit 1
fi

required_paths=(
  ".DS_Store"
  ".background.png"
  "LiveAgent.app"
  "Applications"
)

for required_path in "${required_paths[@]}"; do
  if [[ ! -e "$mount_path/$required_path" ]]; then
    echo "macOS DMG is missing required Finder layout content: $required_path" >&2
    exit 1
  fi
done

if [[ ! -L "$mount_path/Applications" ]]; then
  echo "macOS DMG Applications entry is not a symbolic link" >&2
  exit 1
fi

echo "macOS DMG Finder layout verified: $dmg_path"
