#!/usr/bin/env bash
# Asserts that the compiled Linux release binary does not require GLIBC symbol
# versions newer than the supported baseline.
#
# The README promises Ubuntu 22.04+ / Debian 12+, so the binary must not need
# anything above GLIBC 2.35. Building on a newer host (for example the
# ubuntu-latest runner, Ubuntu 24.04 / glibc 2.39) silently links against
# GLIBC_2.38/2.39 and the app exits at dynamic-link time on Ubuntu 22.04 with
# "version `GLIBC_2.38' not found". This guard keeps that regression from shipping.
#
# Usage: verify-linux-glibc-baseline.sh [binary ...]
# Without arguments it inspects the release binary produced by `tauri build`.
# Override the baseline with LIVEAGENT_GLIBC_BASELINE (default 2.35).
set -euo pipefail

readonly DEFAULT_BASELINE="2.35"
baseline="${LIVEAGENT_GLIBC_BASELINE:-$DEFAULT_BASELINE}"

fail() {
  echo "verify-linux-glibc-baseline: $*" >&2
  exit 1
}

# Returns 0 when version $1 is strictly greater than version $2.
version_gt() {
  [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -n1)" = "$1" ]
}

for command_name in objdump grep sed sort awk; do
  command -v "$command_name" >/dev/null 2>&1 || fail "missing required command: $command_name"
done

binaries=()
if [ "$#" -gt 0 ]; then
  binaries=("$@")
else
  for candidate in \
    "target/x86_64-unknown-linux-gnu/release/liveagent" \
    "crates/agent-gui/src-tauri/target/x86_64-unknown-linux-gnu/release/liveagent" \
    "target/release/liveagent" \
    "crates/agent-gui/src-tauri/target/release/liveagent"; do
    [ -f "$candidate" ] && binaries+=("$candidate")
  done
fi

[ "${#binaries[@]}" -gt 0 ] || fail "no LiveAgent release binary found to inspect (build it first or pass a path)"

status=0
for binary in "${binaries[@]}"; do
  test -f "$binary" || fail "binary not found: $binary"

  mapfile -t versions < <(
    objdump -T "$binary" 2>/dev/null \
      | grep -oE 'GLIBC_[0-9]+(\.[0-9]+)+' \
      | sed 's/^GLIBC_//' \
      | sort -Vu
  )

  if [ "${#versions[@]}" -eq 0 ]; then
    echo "warn: no GLIBC version symbols found in $binary" >&2
    continue
  fi

  echo "==> $binary"
  echo "    required: $(printf 'GLIBC_%s ' "${versions[@]}")"
  echo "    highest : GLIBC_${versions[-1]} (baseline GLIBC_$baseline)"

  offending=()
  for version in "${versions[@]}"; do
    version_gt "$version" "$baseline" && offending+=("$version")
  done

  if [ "${#offending[@]}" -gt 0 ]; then
    echo "    FAIL  requires GLIBC newer than baseline: $(printf 'GLIBC_%s ' "${offending[@]}")" >&2
    for version in "${offending[@]}"; do
      echo "      symbols requiring GLIBC_$version:" >&2
      # objdump prints the version either bare (GLIBC_2.38) or parenthesised ((GLIBC_2.38)).
      objdump -T "$binary" 2>/dev/null | awk -v token="GLIBC_$version" '
        { for (i = 1; i <= NF; i++) if ($i == token || $i == "(" token ")") { print "        " $0; break } }
      ' >&2 || true
    done
    status=1
  else
    echo "    ok    within baseline"
  fi
done

if [ "$status" -ne 0 ]; then
  fail "Linux binary requires a newer GLIBC than the supported baseline (GLIBC_$baseline).
  Build the Linux release on that baseline (the ubuntu-22.04 runner, or an ubuntu:22.04 container)
  so the artifacts run on Ubuntu 22.04+ / Debian 12+. See Stack-Cairn/LiveAgent#714."
fi

echo "GLIBC baseline verified (<= GLIBC_$baseline): ${binaries[*]}"
