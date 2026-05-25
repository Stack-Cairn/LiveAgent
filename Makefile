.DEFAULT_GOAL := dev

AGENT_GUI_DIR := crates/agent-gui
AGENT_GATEWAY_DIR := crates/agent-gateway
AGENT_GATEWAY_WEB_DIR := $(AGENT_GATEWAY_DIR)/web
AGENT_GATEWAY_PROTO_FILE := proto/v1/gateway.proto

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

DEV_GATEWAY_TOKEN ?= dev-token
DEV_GATEWAY_HTTP_ADDR ?= :8080
DEV_GATEWAY_GRPC_ADDR ?= :50051
GATEWAY_DOCKER_IMAGE ?= liveagent-gateway:local

.PHONY: all dev build desktop-build-macos desktop-build-macos-release desktop-build-macos-intel desktop-build-macos-m desktop-build-windows desktop-build-linux help
.PHONY: dev-gateway dev-webui
.PHONY: proto webui gateway-build gateway-docker-build gateway-docker-run gateway-docker-smoke build-linux build-linux-amd build-linux-arm
.PHONY: clean check-rust-target-% check-macos-signing-identity check-macos-notary-profile desktop-store-macos-notary-profile desktop-wait-macos-notary desktop-staple-macos desktop-verify-macos

all: build gateway-build

## Desktop app
dev:
	pnpm --dir $(AGENT_GUI_DIR) tauri dev

build:
	pnpm --dir $(AGENT_GUI_DIR) tauri build

desktop-build-macos: check-rust-target-$(DESKTOP_MACOS_TARGET)
	pnpm --dir $(AGENT_GUI_DIR) tauri build --config $(DESKTOP_MACOS_TAURI_CONFIG) --target $(DESKTOP_MACOS_TARGET)

desktop-build-macos-release: check-rust-target-$(DESKTOP_MACOS_TARGET) check-macos-signing-identity check-macos-notary-profile
	env -u APPLE_ID -u APPLE_PASSWORD -u APPLE_API_ISSUER -u APPLE_API_KEY -u APPLE_API_KEY_PATH APPLE_SIGNING_IDENTITY="$(APPLE_SIGNING_IDENTITY)" pnpm --dir $(AGENT_GUI_DIR) tauri build --config $(DESKTOP_MACOS_TAURI_CONFIG) --target $(DESKTOP_MACOS_TARGET)
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

## Gateway development
dev-gateway:
	go -C $(AGENT_GATEWAY_DIR) run ./cmd/gateway --token=$(DEV_GATEWAY_TOKEN) --http-addr=$(DEV_GATEWAY_HTTP_ADDR) --grpc-addr=$(DEV_GATEWAY_GRPC_ADDR)

dev-webui:
	pnpm --dir $(AGENT_GATEWAY_WEB_DIR) dev -- --proxy-api=http://localhost:8080

## Gateway build and generated assets
proto:
	@command -v protoc >/dev/null || (echo "protoc is required" && exit 1)
	@command -v protoc-gen-go >/dev/null || (echo "protoc-gen-go is required. Run: go install google.golang.org/protobuf/cmd/protoc-gen-go@latest" && exit 1)
	@command -v protoc-gen-go-grpc >/dev/null || (echo "protoc-gen-go-grpc is required. Run: go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest" && exit 1)
	protoc \
		--proto_path=$(AGENT_GATEWAY_DIR) \
		--go_out=$(AGENT_GATEWAY_DIR) \
		--go_opt=module=github.com/liveagent/agent-gateway \
		--go-grpc_out=$(AGENT_GATEWAY_DIR) \
		--go-grpc_opt=module=github.com/liveagent/agent-gateway \
		$(AGENT_GATEWAY_PROTO_FILE)

webui:
	pnpm --dir $(AGENT_GATEWAY_WEB_DIR) install --offline
	pnpm --dir $(AGENT_GATEWAY_WEB_DIR) build

gateway-build: proto webui
	CGO_ENABLED=0 go -C $(AGENT_GATEWAY_DIR) build -o bin/liveagent-gateway ./cmd/gateway

gateway-docker-build:
	docker build -t $(GATEWAY_DOCKER_IMAGE) .

gateway-docker-run:
	docker run --rm -p 8080:8080 -p 50051:50051 -e LIVEAGENT_GATEWAY_TOKEN=$(DEV_GATEWAY_TOKEN) $(GATEWAY_DOCKER_IMAGE)

gateway-docker-smoke: gateway-docker-build
	@set -e; \
	name="liveagent-gateway-smoke"; \
	docker rm -f "$$name" >/dev/null 2>&1 || true; \
	docker run --rm -d --name "$$name" -p 18080:8080 -e LIVEAGENT_GATEWAY_TOKEN=$(DEV_GATEWAY_TOKEN) $(GATEWAY_DOCKER_IMAGE) >/dev/null; \
	trap 'docker rm -f "$$name" >/dev/null 2>&1 || true' EXIT; \
	for _ in $$(seq 1 30); do \
		if curl -fsS http://127.0.0.1:18080/healthz | grep -q '"ok":true'; then \
			echo "Gateway Docker smoke test passed: http://127.0.0.1:18080/healthz"; \
			exit 0; \
		fi; \
		sleep 1; \
	done; \
	docker logs "$$name"; \
	exit 1

build-linux: proto webui
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go -C $(AGENT_GATEWAY_DIR) build -o bin/liveagent-gateway-linux-amd64 ./cmd/gateway

build-linux-amd: build-linux

build-linux-arm: proto webui
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go -C $(AGENT_GATEWAY_DIR) build -o bin/liveagent-gateway-linux-arm64 ./cmd/gateway

build-windows: proto webui
	CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go -C $(AGENT_GATEWAY_DIR) build -o bin/liveagent-gateway-windows-amd64.exe ./cmd/gateway

gateway-build-windows: build-windows

## Maintenance
clean:
	rm -rf $(AGENT_GATEWAY_DIR)/bin/ $(AGENT_GATEWAY_WEB_DIR)/dist/

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
	@printf "\n%s\n" "Gateway development"
	@printf "  %-34s %s\n" "make dev-gateway" "启动 agent-gateway Go 服务"
	@printf "  %-34s %s\n" "make dev-webui" "启动 agent-gateway Web UI 开发服务"
	@printf "\n%s\n" "Gateway build"
	@printf "  %-34s %s\n" "make proto" "生成 agent-gateway protobuf 代码"
	@printf "  %-34s %s\n" "make webui" "构建 agent-gateway Web UI"
	@printf "  %-34s %s\n" "make gateway-build" "构建 agent-gateway 本地二进制"
	@printf "  %-34s %s\n" "make gateway-docker-build" "构建 agent-gateway Docker 镜像"
	@printf "  %-34s %s\n" "make gateway-docker-run" "本地运行 agent-gateway Docker 镜像"
	@printf "  %-34s %s\n" "make gateway-docker-smoke" "构建并健康检查 agent-gateway Docker 镜像"
	@printf "  %-34s %s\n" "make build-linux" "构建 agent-gateway Linux amd64 二进制"
	@printf "  %-34s %s\n" "make build-linux-arm" "构建 agent-gateway Linux arm64 二进制"
	@printf "  %-34s %s\n" "make build-windows" "构建 agent-gateway Windows amd64 二进制"
	@printf "\n%s\n" "Maintenance"
	@printf "  %-34s %s\n" "make all" "同时构建 GUI 和 agent-gateway"
	@printf "  %-34s %s\n" "make clean" "清理 agent-gateway 构建产物"
	@printf "  %-34s %s\n" "make help" "查看可用命令"
