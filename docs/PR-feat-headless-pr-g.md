# PR Title

```
feat(headless): headless server runtime, manifest-driven command adapters, security hardening, and dev-tools Docker images
```

---

# PR Body

## Summary

Adds a full **headless runtime** for LiveAgent: the same business command
surface the desktop build exposes via `#[tauri::command]` now also runs as a
standalone axum HTTP/WebSocket server (`--no-default-features`, no Tauri),
serving the existing WebUI through an in-page bridge — plus a reproducible
command-registry/generator pipeline, a same-origin security model, and
layered dev-tools Docker images (`core`/`full`) managed with `mise`.

**32 commits, 153 files changed (+14,775 / −1,701).**

## Why

- Let the WebUI run in a container/server without the desktop Tauri runtime
  (browser mode, remote deployment, dev sandboxes).
- Decouple the business layer from Tauri so the same command surface is
  reusable across runtimes.
- Make the 234-command adapter layer **generated and verified, not
  hand-synced** (the historical drift failure mode of the headless build).
- Close the CORS/WS/rate-limit holes in the initial headless server.

## Highlights

### 1. Decouple business layer from Tauri (P1.1)
- `refactor: decouple event emission from tauri AppHandle (P1.1 PR-A)`
- `refactor: decouple tauri State/command macro from business layer (P1.1 PR-B)`
- `refactor: extract AppContext assembly, gate desktop-only modules (P1.1 PR-C)`

### 2. Headless runtime (P1.2)
- `build: feature-gate Tauri deps, headless build strips Tauri (P1.2 PR-D)`
- `feat: add headless binary with axum server and command dispatch (P1.2 PR-E)`
- `feat: add same-interface tauriBridge so WebUI can run headless (P1.2 PR-F)`
- `ci: add headless-rust job guarding the no-default-features build (P1.2 PR-G)`
- `feat: serve WebUI statics with SPA fallback and same-origin base URL (P1.2 PR-H)`
- Follow-up fixes: workspace picker, loopback rate-limit exemption, route
  fixes, `/proc` process-group liveness probe for the runtime bridge.

Routes: `GET /health`, `GET /api/status`, `POST /api/invoke`,
`GET /ws` (event broadcast), `GET /*` (WebUI SPA fallback),
`/proxy/{provider}/` BFF routes (page-origin base URL).

### 3. Command registry & generator (reproducibility)
- `scripts/manifest/commands.json` — **committed source of truth** for the
  234 Tauri commands (replaces the old un-reproducible `/tmp` snapshot flow).
- `scripts/build_type_map.py` — derives the Rust type map from `src/*.rs`.
- `scripts/gen_adapters.py` — regenerates `src/commands/adapters.rs`
  (desktop-only thin adapters re-attaching `#[tauri::command]`).
- `scripts/gen_headless.sh` — one-shot pipeline (`build_type_map` →
  `gen_adapters`), wired into CI `gen-verify` job with `git diff --exit-code`.
- `scripts/verify_headless.py` — asserts `headless.rs` dispatch arms match the
  manifest **both ways** (missing + extra). Currently 234 = 234.
- `scripts/extract_cmds.py` / `gen_headless.py` marked `[HISTORICAL]`.
- New-command flow documented in README (5 steps).

### 4. Security hardening
- **Same-origin gate** replaces permissive `CorsLayer(Any)`: requests with an
  `Origin` that is neither same-origin nor `LIVEAGENT_HEADLESS_CORS_ORIGINS`
  are 403'd before routing; OPTIONS preflight returns proper CORS headers.
- **`/api/invoke` token auth** (`LIVEAGENT_API_TOKEN`) with same-origin
  exemption for the WebUI; non-browser callers must send `Authorization: Bearer`.
- **`/ws` origin check**: browser (same-origin) connections pass;
  non-browser clients must send `?token=` when a token is configured.
- **Rate-limit IP** now uses the real TCP peer (`ConnectInfo<SocketAddr>`);
  `X-Forwarded-For` is only trusted with `LIVEAGENT_TRUST_PROXY_HEADERS=1`.
- Warn at startup when bound to a non-loopback interface without a token.
- Fix pre-existing `runtime-fallback` build bug (`serve_static_path` was not
  `async` though it awaits).

### 5. Dev-tools Docker images (core / full)
- Layered images with `mise`-managed runtimes (`docker/mise.core.toml`,
  `docker/mise.full.toml`), lazy-loading, and a `timeout`-bounded `mise
  install` in `entrypoint.sh`.
- Toolchain reachability fix: `/etc/profile.d/mise.sh` injects the full mise
  env into **login shells** (covers the app's `bash -lc` exec path);
  `bash.bashrc` keeps covering interactive shells; PATH fallback via
  `/opt/mise/shims` for non-shell processes.
- `bun 1.3.14` installed via the **npm backend** (npmmirror) — the mise core
  backend hardcodes GitHub releases, which is unreachable in restricted
  networks; injection layers and npm-registry routing documented in README.
- Consolidated the headless image workflow; removed the old single-image
  workflow (`liveagent-docker.yml` + `Dockerfile.headless`).

### 6. CI build chain
- Rust bumped through 1.85 → 1.88 → 1.90 → 1.97 for `libsqlite3-sys`
  cfg_select / `lopdf` / `zip` / `time` / `base16ct` compat.
- `libclang-dev` (rquickjs-sys bindgen) and `protobuf-compiler` (gateway
  proto) installed in the headless image build.
- Cargo cache isolated per arch to stop parallel buildx races.
- WebUI `dist` embedded in the headless image; server binds `0.0.0.0`.
- LiveAgent home pointed at the data volume so the history DB is writable.

### 7. WebUI
- `HeadlessFolderPicker` for workspace directory selection (quick locations
  simplified to `/workspace` for the headless deployment).

## Verification

- `scripts/verify_headless.py`: **234 manifest commands = 234 dispatch arms**
  (missing + extra, both ways) — `OK`.
- `cargo test --no-default-features --lib`: **657 passed; 0 failed** (current
  HEAD `07bfc20d`).
- `cargo check --no-default-features` (embedded) and
  `cargo check --no-default-features --features runtime-fallback`: pass.
- Generator re-entrancy: `gen_headless.sh` → `git diff --exit-code
  adapters.rs` → `verify_headless.py` (234 = 234).
- Live behavior matrix (auth off/on): same-origin 200, cross-origin 403,
  preflight 204 + CORS headers, Bearer auth, WS `?token=` auth, cross-origin
  WS 403 — all as designed.
- Release-binary smoke test on the headless server: pass.
- Images: `core`/`full` built and published to GHCR; container verified with
  full toolchain visible under `bash -lc`, WebUI HTTP 200, API/WS working.

## Compatibility

- Default `desktop` build is unaffected — Tauri deps stay feature-gated;
  `adapters.rs` and `headless.rs` are mutually exclusive by feature.
- The generated adapter layer preserves the exact pre-refactor command names.

## Notes for reviewers

- Branch has been **rebased onto the latest `upstream/main` (`00a2c6fc`)**;
  merge-tree probe shows **0 conflicts** with `upstream/main`.
  - One conflict was resolved during rebase: `ProvidersSection.tsx` import
    block — this branch's `openFolderPicker` import was kept, while the
    `ProviderIdentityDrawer` import (and its UI) was dropped to align with
    upstream's removal of the built-in CLI identity feature (commit
    `0f95b836` etc.). No other files conflicted.
- WebSocket token auth is query-param only (`?token=`) by design: browser
  `WebSocket` cannot set custom headers.
- The `headless.rs` dispatch block is hand-maintained and *verified* (not
  regenerated) — the generator only produces `adapters.rs`.

## PR Status

- **PR**: [#379](https://github.com/Stack-Cairn/LiveAgent/pull/379)
- **Issue**: [#380](https://github.com/Stack-Cairn/LiveAgent/issues/380)
- **State**: Open — awaiting human review
- **Governance**: ✅ Passed (linked issue + screenshots)
- **Mergeable**: True (no conflicts)
