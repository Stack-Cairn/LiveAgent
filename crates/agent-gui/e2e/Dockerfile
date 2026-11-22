# syntax=docker/dockerfile:1.7
#
# Toolchain image for the desktop end-to-end suite: WebKitGTK, WebKitWebDriver,
# tauri-driver, Xvfb, Node/pnpm and Rust. The repository is mounted at run time
# (see crates/agent-gui/e2e/run-docker.sh), so the image only changes when the
# toolchain does, and cargo/pnpm caches live in named volumes.
FROM ubuntu:24.04

ARG NODE_VERSION=22.19.0
ARG PNPM_VERSION=10.32.1
ARG TAURI_DRIVER_VERSION=2.0.6

ENV CARGO_HOME=/usr/local/cargo \
    RUSTUP_HOME=/usr/local/rustup \
    PNPM_HOME=/usr/local/pnpm \
    CI=true \
    LANG=C.UTF-8
ENV PATH=/usr/local/cargo/bin:/usr/local/pnpm:/usr/local/node/bin:$PATH

COPY install-linux-deps.sh /tmp/install-linux-deps.sh
RUN E2E_CLEAN_APT_LISTS=1 /tmp/install-linux-deps.sh && rm /tmp/install-linux-deps.sh

RUN set -eux; \
    case "$(uname -m)" in x86_64) arch=x64 ;; aarch64) arch=arm64 ;; *) exit 1 ;; esac; \
    mkdir -p /usr/local/node; \
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${arch}.tar.xz" \
      | tar -xJ -C /usr/local/node --strip-components=1; \
    npm install -g "pnpm@${PNPM_VERSION}"; \
    node --version; pnpm --version

RUN set -eux; \
    curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable --no-modify-path; \
    cargo install tauri-driver --locked --version "${TAURI_DRIVER_VERSION}"; \
    rm -rf "${CARGO_HOME}/registry" "${CARGO_HOME}/git"; \
    chmod -R a+rwX "${CARGO_HOME}" "${RUSTUP_HOME}"

WORKDIR /workspace
