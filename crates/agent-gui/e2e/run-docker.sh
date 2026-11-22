#!/usr/bin/env bash
# Runs the desktop E2E suite inside the Linux toolchain image.
#
#   crates/agent-gui/e2e/run-docker.sh            # build image, build app, run all specs
#   crates/agent-gui/e2e/run-docker.sh --spec specs/02-chat-stream.e2e.mjs
#
# The repository is mounted read-only and copied into a named volume, so Linux
# node_modules and the cargo target dir never touch the host checkout. The app
# build has network access (crates, npm); the test run itself uses
# `--network none`, so the app can only reach the loopback fake provider.
#
# Environment:
#   LIVEAGENT_KBRAIN_BINARY  host path to a Linux kn for the container's arch
#                            (required on arm64 hosts: no pinned arm64 Linux release)
#   E2E_ARTIFACTS_DIR        host dir for screenshots/logs (default: e2e/.artifacts)
#   E2E_IMAGE                image tag (default: liveagent-desktop-e2e:local)
#   E2E_SKIP_IMAGE_BUILD=1   reuse an existing image
#   E2E_SKIP_APP_BUILD=1     reuse the previously built app in the volume
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
image="${E2E_IMAGE:-liveagent-desktop-e2e:local}"
artifacts="${E2E_ARTIFACTS_DIR:-$here/.artifacts}"
volume_prefix="${E2E_VOLUME_PREFIX:-liveagent-desktop-e2e}"
mkdir -p "$artifacts"

if [ "${E2E_SKIP_IMAGE_BUILD:-0}" != "1" ]; then
  docker build -t "$image" -f "$here/Dockerfile" "$here/docker"
fi

common=(
  --rm
  -v "$repo:/src:ro"
  -v "$volume_prefix-workspace:/workspace"
  -v "$volume_prefix-cargo-registry:/usr/local/cargo/registry"
  -v "$volume_prefix-pnpm-store:/pnpm-store"
  -v "$artifacts:/artifacts"
  -e npm_config_store_dir=/pnpm-store
  -e CARGO_TERM_COLOR=always
  -e "RUSTFLAGS=-C link-arg=-fuse-ld=mold"
)
if [ -n "${LIVEAGENT_KBRAIN_BINARY:-}" ]; then
  common+=(-v "$LIVEAGENT_KBRAIN_BINARY:/opt/e2e/kn:ro" -e LIVEAGENT_KBRAIN_BINARY=/opt/e2e/kn)
fi

# 1) Sync sources and build (network on).
docker run "${common[@]}" -e E2E_SKIP_APP_BUILD="${E2E_SKIP_APP_BUILD:-0}" "$image" bash -euo pipefail -c '
  tar -C /src \
    --exclude=./.git --exclude=node_modules --exclude=./target --exclude=dist \
    --exclude=./crates/agent-gui/src-tauri/binaries \
    --exclude=./crates/agent-gui/e2e/.run --exclude=./crates/agent-gui/e2e/.artifacts \
    -cf - . | tar -C /workspace -xf -
  cd /workspace
  pnpm install --frozen-lockfile --prefer-offline \
    --filter liveagent-workspace --filter "liveagent..." \
    --filter "@liveagent/gateway-webui..." --filter "@liveagent/desktop-e2e..."
  if [ "${E2E_SKIP_APP_BUILD:-0}" != "1" ] || [ ! -x target/debug/liveagent ]; then
    pnpm --filter @liveagent/desktop-e2e build:app
  fi
' 2>&1 | tee "$artifacts/docker-build.log"

# 2) Run the suite offline under a virtual display and a session bus.
shift_args=$(printf '%q ' "$@")
# --init: xvfb-run waits for a signal from Xvfb that never arrives when it is PID 1.
docker run "${common[@]}" --init --network none --shm-size=1g \
  -e E2E_ARTIFACTS_DIR=/artifacts -e E2E_RUN_DIR=/tmp/e2e-run \
  -e E2E_SCREENSHOTS="${E2E_SCREENSHOTS:-}" -e E2E_LOG_LEVEL="${E2E_LOG_LEVEL:-}" \
  -e E2E_TEST_TIMEOUT="${E2E_TEST_TIMEOUT:-}" -e E2E_RETRIES="${E2E_RETRIES:-}" \
  "$image" bash -euo pipefail -c "
  cd /workspace/crates/agent-gui/e2e
  xvfb-run -a -s '-screen 0 1600x1000x24' dbus-run-session -- pnpm exec wdio run wdio.conf.mjs $shift_args
"
