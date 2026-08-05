# syntax=docker/dockerfile:1.7

# 阶段1：构建 Node 引擎 bundle
# agent-core-js 经 esbuild 打包成单文件 dist/index.js
FROM --platform=$BUILDPLATFORM node:22.17.1-bookworm-slim AS engine-builder

WORKDIR /src/crates/agent-core-js

# 安装 pnpm
RUN npm install -g pnpm@10.32.1

# 复制依赖声明
COPY crates/agent-core-js/package.json crates/agent-core-js/pnpm-lock.yaml ./

# 安装依赖
RUN pnpm install --frozen-lockfile

# 复制源码
COPY crates/agent-core-js ./

# 构建：tsc 类型检查 + esbuild 打包
RUN pnpm build

# 阶段2：构建 Rust 后端二进制
# agent-backend（workspace 内，agent-core 是依赖）
FROM --platform=$BUILDPLATFORM rust:1-bookworm AS backend-builder

# 保持这些 ARG 裸露：不赋默认值，让 buildx 按每平台注入
ARG TARGETOS
ARG TARGETARCH

WORKDIR /src

# 复制 Cargo workspace 根
COPY Cargo.toml Cargo.lock ./

# 复制三个 crate（agent-backend 依赖 agent-core）
COPY crates/agent-backend ./crates/agent-backend
COPY crates/agent-core ./crates/agent-core
COPY crates/agent-gui ./crates/agent-gui

# 缓存依赖下载
RUN cargo fetch --manifest-path crates/agent-backend/Cargo.toml

# 构建 agent-backend release 二进制
# 注意：workspace 成员内所有依赖都会链接，包括 agent-core
RUN cargo build -p agent-backend --release \
    --target-dir /out/target

# 阶段3：运行时镜像
# node:22-bookworm-slim 自带 Node 和必要的系统库，不需手动装 runtime
FROM node:22.17.1-bookworm-slim AS runtime

# 非 root 用户：权限隔离
RUN useradd --system --uid 10001 --user-group --home-dir /nonexistent --shell /usr/sbin/nologin liveagent \
    && install -d -o liveagent -g liveagent -m 0700 /opt/liveagent/engine

# 从 backend-builder 阶段复制 Rust 二进制
COPY --from=backend-builder /out/target/release/agent-backend /usr/local/bin/agent-backend

# 从 engine-builder 阶段复制 Node 引擎 bundle
COPY --from=engine-builder /src/crates/agent-core-js/dist/index.js /opt/liveagent/engine/index.js

# 入口脚本：把平台注入的环境变量翻成 argv（后端只认 argv）
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh

# 调整所有权为 liveagent 用户
RUN chown -R liveagent:liveagent /opt/liveagent

USER liveagent

EXPOSE 8443

ENTRYPOINT ["docker-entrypoint.sh"]
