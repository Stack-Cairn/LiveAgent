# syntax=docker/dockerfile:1.7

# 阶段1：构建 Node 引擎 bundle
# core 经 esbuild 打包成单文件 dist/index.js
FROM --platform=$BUILDPLATFORM node:22.19.0-bookworm-slim AS engine-builder

WORKDIR /src/crates/core

# 安装 pnpm
RUN npm install -g pnpm@10.32.1

# 复制依赖声明
COPY crates/core/package.json crates/core/pnpm-lock.yaml ./

# 安装依赖
RUN pnpm install --frozen-lockfile

# 复制源码
COPY crates/core ./

# 构建：tsc 类型检查 + esbuild 打包
RUN pnpm build

# 阶段2：构建 Rust 后端二进制
FROM --platform=$BUILDPLATFORM rust:1-bookworm AS backend-builder

# 保持这些 ARG 裸露：不赋默认值，让 buildx 按每平台注入
ARG TARGETOS
ARG TARGETARCH

WORKDIR /src

# 复制 Cargo workspace 根
COPY Cargo.toml Cargo.lock ./

# 复制两个 crate
COPY crates/backend ./crates/backend
COPY crates/frontend ./crates/frontend

# 缓存依赖下载
RUN cargo fetch --manifest-path crates/backend/Cargo.toml

# 构建 backend release 二进制
RUN cargo build -p backend --release \
    --target-dir /out/target

# 阶段3：运行时镜像
# node:22-bookworm-slim 自带 Node 和必要的系统库，chat 引擎（core bundle）跑在它上面。
FROM node:22.19.0-bookworm-slim AS runtime

# 非 root 用户：权限隔离。数据目录 /var/lib/liveagent 建好并归属该用户，
# 供 VOLUME 挂载持久化。
RUN useradd --system --uid 10001 --user-group --home-dir /var/lib/liveagent --shell /usr/sbin/nologin liveagent \
    && install -d -o liveagent -g liveagent -m 0700 /opt/liveagent/engine /var/lib/liveagent

# 从 backend-builder 阶段复制 Rust 二进制
COPY --from=backend-builder /out/target/release/backend /usr/local/bin/backend

# 从 engine-builder 阶段复制 Node 引擎 bundle
COPY --from=engine-builder /src/crates/core/dist/index.js /opt/liveagent/engine/index.js

# 调整所有权为 liveagent 用户
RUN chown -R liveagent:liveagent /opt/liveagent

USER liveagent

# 后端直接认环境变量（PORT、LIVEAGENT_BACKEND_PASSWORD 也可覆盖），
# 不再需要 entrypoint 脚本翻译。
#
# HOME 显式指到数据卷：Node 侧的库会读写 `~` 下的配置。原先这个用户的
# home 是 /nonexistent，Node 程序往那儿写就是 EACCES。
ENV LIVEAGENT_DATA_DIR=/var/lib/liveagent \
    LIVEAGENT_ENGINE_BUNDLE=/opt/liveagent/engine \
    HOME=/var/lib/liveagent

VOLUME ["/var/lib/liveagent"]

EXPOSE 8443

ENTRYPOINT ["/usr/local/bin/backend"]
