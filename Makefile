.DEFAULT_GOAL := dev

AGENT_GUI_DIR := crates/frontend
AGENT_BACKEND_DIR := crates/backend

HOST_ARCH := $(shell uname -m)

DESKTOP_MACOS_INTEL_TARGET ?= x86_64-apple-darwin
DESKTOP_MACOS_M_TARGET ?= aarch64-apple-darwin
ifeq ($(HOST_ARCH),arm64)
DESKTOP_MACOS_TARGET ?= $(DESKTOP_MACOS_M_TARGET)
else
DESKTOP_MACOS_TARGET ?= $(DESKTOP_MACOS_INTEL_TARGET)
endif
DESKTOP_WINDOWS_TARGET ?= x86_64-pc-windows-msvc
DESKTOP_LINUX_TARGET ?= x86_64-unknown-linux-gnu
DESKTOP_LINUX_BUNDLES ?= appimage deb rpm
DESKTOP_MACOS_APP_NAME ?= LiveAgent
DESKTOP_MACOS_NOTARY_PROFILE ?= liveagent-notary
DESKTOP_MACOS_TAURI_CONFIG ?= src-tauri/tauri.macos.conf.json
DESKTOP_WINDOWS_TAURI_CONFIG ?= src-tauri/tauri.windows.conf.json
DESKTOP_RELEASE_TAURI_CONFIG ?= src-tauri/tauri.macos.release.conf.json
DESKTOP_RELEASE_TAURI_CONFIG_FLAGS ?= --config $(DESKTOP_RELEASE_TAURI_CONFIG) $(if $(LIVEAGENT_TAURI_VERSION_CONFIG),--config $(LIVEAGENT_TAURI_VERSION_CONFIG))

MODEL_CATALOG_GENERATED_FILES := $(AGENT_GUI_DIR)/src/lib/models/catalog.generated.ts

BACKEND_DOCKER_IMAGE ?= liveagent-backend:local
RELEASE_TAG ?=

.PHONY: all dev build desktop-build-macos desktop-build-macos-release desktop-build-macos-intel desktop-build-macos-m desktop-build-windows desktop-build-linux github-release-main check-github-release-tag help
.PHONY: backend-docker-build backend-docker-run backend-docker-smoke
.PHONY: clean update-model-catalog check-rust-target-% check-macos-signing-identity check-macos-notary-profile desktop-store-macos-notary-profile desktop-wait-macos-notary desktop-staple-macos desktop-verify-macos
.PHONY: update-routes check-routes check-command-classes

all: build

## Desktop app
dev:
	pnpm --dir $(AGENT_GUI_DIR) tauri dev

build:
	pnpm --dir $(AGENT_GUI_DIR) tauri build

desktop-build-macos: check-rust-target-$(DESKTOP_MACOS_TARGET)
	pnpm --dir $(AGENT_GUI_DIR) tauri build --config $(DESKTOP_MACOS_TAURI_CONFIG) --target $(DESKTOP_MACOS_TARGET)

desktop-build-macos-release: check-rust-target-$(DESKTOP_MACOS_TARGET) check-macos-signing-identity check-macos-notary-profile
	env -u APPLE_ID -u APPLE_PASSWORD -u APPLE_API_ISSUER -u APPLE_API_KEY -u APPLE_API_KEY_PATH APPLE_SIGNING_IDENTITY="$(APPLE_SIGNING_IDENTITY)" pnpm --dir $(AGENT_GUI_DIR) tauri build $(DESKTOP_RELEASE_TAURI_CONFIG_FLAGS) --target $(DESKTOP_MACOS_TARGET)
	@set -e; \
	app_path="target/$(DESKTOP_MACOS_TARGET)/release/bundle/macos/$(DESKTOP_MACOS_APP_NAME).app"; \
	dmg_path="$$(find "target/$(DESKTOP_MACOS_TARGET)/release/bundle/dmg" -maxdepth 1 -name '$(DESKTOP_MACOS_APP_NAME)_*.dmg' -print -quit)"; \
	if [ ! -d "$$app_path" ]; then echo "macOS app not found: $$app_path"; exit 1; fi; \
	if [ -z "$$dmg_path" ] || [ ! -f "$$dmg_path" ]; then echo "macOS dmg not found under target/$(DESKTOP_MACOS_TARGET)/release/bundle/dmg"; exit 1; fi; \
	codesign --verify --deep --strict --verbose=4 "$$app_path"; \
	codesign --force --timestamp --sign "$(APPLE_SIGNING_IDENTITY)" "$$dmg_path"; \
	xcrun notarytool submit "$$dmg_path" --keychain-profile "$(DESKTOP_MACOS_NOTARY_PROFILE)" --wait; \
	xcrun stapler staple "$$dmg_path"; \
	xcrun stapler validate -v "$$dmg_path"; \
	spctl --assess --type execute --verbose=4 "$$app_path"; \
	spctl --assess --type open --context context:primary-signature --verbose=4 "$$dmg_path"; \
	echo "macOS release dmg is ready: $$dmg_path"

desktop-build-macos-intel: check-rust-target-$(DESKTOP_MACOS_INTEL_TARGET)
	pnpm --dir $(AGENT_GUI_DIR) tauri build --config $(DESKTOP_MACOS_TAURI_CONFIG) --target $(DESKTOP_MACOS_INTEL_TARGET)

desktop-build-macos-m: check-rust-target-$(DESKTOP_MACOS_M_TARGET)
	pnpm --dir $(AGENT_GUI_DIR) tauri build --config $(DESKTOP_MACOS_TAURI_CONFIG) --target $(DESKTOP_MACOS_M_TARGET)

desktop-build-windows: check-rust-target-$(DESKTOP_WINDOWS_TARGET)
	pnpm --dir $(AGENT_GUI_DIR) tauri build --config $(DESKTOP_WINDOWS_TAURI_CONFIG) --target $(DESKTOP_WINDOWS_TARGET)

desktop-build-linux: check-rust-target-$(DESKTOP_LINUX_TARGET)
	pnpm --dir $(AGENT_GUI_DIR) tauri build --target $(DESKTOP_LINUX_TARGET) --bundles $(DESKTOP_LINUX_BUNDLES)

github-release-main: check-github-release-tag
	git fetch origin --tags
	git switch main
	git pull --ff-only origin main
	@set -e; \
	if [ -n "$$(git status --porcelain)" ]; then \
		echo "Working tree is not clean after syncing main. Commit or stash changes before release."; \
		git status --short --branch; \
		exit 1; \
	fi
	git status --short --branch
	@set -e; \
	if git rev-parse -q --verify "refs/tags/$(RELEASE_TAG)" >/dev/null; then \
		echo "Release tag already exists locally: $(RELEASE_TAG)"; \
		exit 1; \
	fi; \
	if git ls-remote --exit-code --tags origin "refs/tags/$(RELEASE_TAG)" >/dev/null 2>&1; then \
		echo "Release tag already exists on origin: $(RELEASE_TAG)"; \
		exit 1; \
	fi
# The catalog refresh must land on main before the tag is cut, and only after
# test:release has validated the new snapshot (catalog invariant tests).
	$(MAKE) update-model-catalog
	pnpm --dir $(AGENT_GUI_DIR) install --frozen-lockfile
	pnpm --dir $(AGENT_GUI_DIR) test:release
	cargo check --manifest-path $(AGENT_GUI_DIR)/src-tauri/Cargo.toml --tests
	@set -e; \
	if ! git diff --quiet -- $(MODEL_CATALOG_GENERATED_FILES); then \
		git add $(MODEL_CATALOG_GENERATED_FILES); \
		git commit -m "chore(models): refresh model catalog for $(RELEASE_TAG)"; \
		git push origin main; \
	else \
		echo "Model catalog is already up to date."; \
	fi
	node scripts/release/prepare-app-version-from-tag.mjs "$(RELEASE_TAG)" --json
	git tag -a "$(RELEASE_TAG)" -m "LiveAgent $(RELEASE_TAG)"
	git push origin "$(RELEASE_TAG)"

check-github-release-tag:
	@if [ -z "$(RELEASE_TAG)" ]; then echo "RELEASE_TAG is required. Example: make github-release-main RELEASE_TAG=v0.1.10"; exit 1; fi
	@node scripts/release/prepare-app-version-from-tag.mjs "$(RELEASE_TAG)" --json >/dev/null

## Backend build and Docker
backend-docker-build:
	docker build -t $(BACKEND_DOCKER_IMAGE) .

backend-docker-run:
	docker run --rm -p 8443:8443 $(BACKEND_DOCKER_IMAGE)

backend-docker-smoke: backend-docker-build
	@set -e; \
	name="liveagent-backend-smoke"; \
	docker rm -f "$$name" >/dev/null 2>&1 || true; \
	docker run -d --name "$$name" -p 18443:8443 $(BACKEND_DOCKER_IMAGE) >/dev/null; \
	trap 'docker rm -f "$$name" >/dev/null 2>&1 || true' EXIT; \
	for _ in $$(seq 1 60); do \
		if curl -fsS http://127.0.0.1:18443/healthz 2>/dev/null | grep -q 'ok'; then \
			echo "Backend Docker smoke test passed: http://127.0.0.1:18443/healthz"; \
			exit 0; \
		fi; \
		sleep 1; \
	done; \
	echo "Backend Docker smoke test failed; container logs:"; \
	docker logs "$$name" || true; \
	exit 1

## Maintenance
clean:
	cargo clean
	rm -rf $(AGENT_GUI_DIR)/dist

update-model-catalog:
	node scripts/generate-model-catalog.mjs

# 从 src-tauri/src/tauri_commands/*.rs 重新生成 backend 的路由层（routes_gen.rs）。
update-routes:
	node scripts/generate-routes.mjs

# 校验 routes_gen.rs 与 wrapper 层一致（CI 用）；漂移即失败。
check-routes:
	node scripts/generate-routes.mjs --check

# 校验每条已注册的 Tauri command 都在 docs/architecture/command-classes/ 里有归类（CI 用）。
check-command-classes:
	@bash scripts/check-command-classes.sh

check-rust-target-%:
	@rustup target list --installed | grep -qx "$*" || (echo "Rust target $* is not installed. Run: rustup target add $*" && exit 1)

check-macos-signing-identity:
	@if [ -z "$(APPLE_SIGNING_IDENTITY)" ]; then echo "APPLE_SIGNING_IDENTITY is required. Example: APPLE_SIGNING_IDENTITY=\"Developer ID Application: Your Name (TEAMID)\" make desktop-build-macos-release"; exit 1; fi
	@security find-identity -v -p codesigning | grep -F -- "\"$(APPLE_SIGNING_IDENTITY)\"" >/dev/null || (echo "Signing identity not found in keychain: $(APPLE_SIGNING_IDENTITY)"; echo "Run: security find-identity -v -p codesigning"; exit 1)

check-macos-notary-profile:
	@xcrun notarytool history --keychain-profile "$(DESKTOP_MACOS_NOTARY_PROFILE)" >/dev/null || (echo "Notary keychain profile is not usable: $(DESKTOP_MACOS_NOTARY_PROFILE)"; echo "Create it with: APPLE_ID=<email> APPLE_TEAM_ID=<team-id> make desktop-store-macos-notary-profile"; exit 1)

desktop-store-macos-notary-profile:
	@if [ -z "$(APPLE_ID)" ]; then echo "APPLE_ID is required. Example: APPLE_ID=name@example.com APPLE_TEAM_ID=UU94JSVAA9 make desktop-store-macos-notary-profile"; exit 1; fi
	@if [ -z "$(APPLE_TEAM_ID)" ]; then echo "APPLE_TEAM_ID is required. Example: APPLE_ID=name@example.com APPLE_TEAM_ID=UU94JSVAA9 make desktop-store-macos-notary-profile"; exit 1; fi
	xcrun notarytool store-credentials "$(DESKTOP_MACOS_NOTARY_PROFILE)" --apple-id "$(APPLE_ID)" --team-id "$(APPLE_TEAM_ID)"

desktop-wait-macos-notary: check-macos-notary-profile
	@if [ -z "$(DESKTOP_MACOS_NOTARY_SUBMISSION_ID)" ]; then echo "DESKTOP_MACOS_NOTARY_SUBMISSION_ID is required. Example: DESKTOP_MACOS_NOTARY_SUBMISSION_ID=<uuid> make desktop-wait-macos-notary"; exit 1; fi
	xcrun notarytool wait "$(DESKTOP_MACOS_NOTARY_SUBMISSION_ID)" --keychain-profile "$(DESKTOP_MACOS_NOTARY_PROFILE)"
	$(MAKE) desktop-staple-macos

desktop-staple-macos:
	@set -e; \
	dmg_path="$$(find "target/$(DESKTOP_MACOS_TARGET)/release/bundle/dmg" -maxdepth 1 -name '$(DESKTOP_MACOS_APP_NAME)_*.dmg' -print -quit)"; \
	if [ -z "$$dmg_path" ] || [ ! -f "$$dmg_path" ]; then echo "macOS dmg not found under target/$(DESKTOP_MACOS_TARGET)/release/bundle/dmg"; exit 1; fi; \
	xcrun stapler staple "$$dmg_path"; \
	$(MAKE) desktop-verify-macos

desktop-verify-macos:
	@set -e; \
	app_path="target/$(DESKTOP_MACOS_TARGET)/release/bundle/macos/$(DESKTOP_MACOS_APP_NAME).app"; \
	dmg_path="$$(find "target/$(DESKTOP_MACOS_TARGET)/release/bundle/dmg" -maxdepth 1 -name '$(DESKTOP_MACOS_APP_NAME)_*.dmg' -print -quit)"; \
	if [ ! -d "$$app_path" ]; then echo "macOS app not found: $$app_path"; exit 1; fi; \
	if [ -z "$$dmg_path" ] || [ ! -f "$$dmg_path" ]; then echo "macOS dmg not found under target/$(DESKTOP_MACOS_TARGET)/release/bundle/dmg"; exit 1; fi; \
	codesign -dv --verbose=4 "$$app_path" 2>&1; \
	codesign --verify --deep --strict --verbose=4 "$$app_path"; \
	xcrun stapler validate -v "$$dmg_path"; \
	spctl --assess --type execute --verbose=4 "$$app_path"; \
	spctl --assess --type open --context context:primary-signature --verbose=4 "$$dmg_path"

help:
	@printf "\n%s\n" "Desktop"
	@printf "  %-34s %s\n" "make / make dev" "启动 Tauri 开发环境"
	@printf "  %-34s %s\n" "make build" "构建当前平台 Tauri 应用"
	@printf "  %-34s %s\n" "make desktop-build-macos" "构建当前 Mac 芯片架构"
	@printf "  %-34s %s\n" "make desktop-build-macos-release" "签名、公证并验证 macOS DMG"
	@printf "  %-34s %s\n" "make desktop-store-macos-notary-profile" "保存 macOS 公证凭据到 Keychain"
	@printf "  %-34s %s\n" "make desktop-wait-macos-notary" "等待指定 macOS 公证提交并 staple"
	@printf "  %-34s %s\n" "make desktop-staple-macos" "对已通过公证的 macOS DMG 执行 staple"
	@printf "  %-34s %s\n" "make desktop-verify-macos" "验证 macOS App/DMG 签名与公证"
	@printf "  %-34s %s\n" "make desktop-build-macos-intel" "构建 macOS Intel 版本"
	@printf "  %-34s %s\n" "make desktop-build-macos-m" "构建 macOS M 系列版本"
	@printf "  %-34s %s\n" "make desktop-build-windows" "构建 Windows Tauri 应用"
	@printf "  %-34s %s\n" "make desktop-build-linux" "构建 Linux AppImage/deb/rpm"
	@printf "  %-34s %s\n" "make github-release-main RELEASE_TAG=vX.Y.Z" "从 main 打 tag 并触发 GitHub Release（自动刷新模型目录并提交）"
	@printf "\n%s\n" "Backend build"
	@printf "  %-34s %s\n" "make backend-docker-build" "构建 backend Docker 镜像"
	@printf "  %-34s %s\n" "make backend-docker-run" "本地运行 backend Docker 镜像"
	@printf "  %-34s %s\n" "make backend-docker-smoke" "构建并健康检查 backend Docker 镜像"
	@printf "\n%s\n" "Maintenance"
	@printf "  %-34s %s\n" "make all" "构建 GUI"
	@printf "  %-34s %s\n" "make clean" "清理构建产物"
	@printf "  %-34s %s\n" "make update-model-catalog" "刷新 models.dev 模型目录快照"
	@printf "  %-34s %s\n" "make update-routes" "从 tauri_commands 重新生成 backend 路由层"
	@printf "  %-34s %s\n" "make check-routes" "校验路由层与 wrapper 一致（CI 门禁）"
	@printf "  %-34s %s\n" "make check-command-classes" "校验 Tauri command 全部已归类（CI 门禁）"
	@printf "  %-34s %s\n" "make help" "查看可用命令"
