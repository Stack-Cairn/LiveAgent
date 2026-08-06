# syntax=docker/dockerfile:1.7

# 阶段1：构建 Rust 后端二进制
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

# 阶段2：运行时镜像
#
# 底座必须自带 Node：chat 引擎是 pi CLI（Node 程序），后端按会话把它作为
# 子进程拉起。**Node 版本不能低于 22.19.0**——pi 的 package.json 写着
# `engines.node >= 22.19.0`，低于它 npm 直接装不上。这里与 mise.toml 固定
# 的开发期版本对齐，避免容器和本地跑在两个 Node 上。
FROM node:22.19.0-bookworm-slim AS runtime

# chat 引擎。版本锁死到具体补丁号：pi 的 RPC 事件形状是我们翻译层的输入契约
# （见 docs/design/pi-rpc-event-contract.md），让它随 ^ 漂移等于让契约漂移。
# 升级 pi 是一次需要重新核对事件契约的动作，不该由一次镜像重建悄悄发生。
ARG PI_VERSION=0.83.0
RUN npm install -g "@earendil-works/pi-coding-agent@${PI_VERSION}" \
    && npm cache clean --force \
    && pi --version

# 非 root 用户：权限隔离。数据目录 /var/lib/liveagent 建好并归属该用户，
# 供 VOLUME 挂载持久化。
RUN useradd --system --uid 10001 --user-group --home-dir /var/lib/liveagent --shell /usr/sbin/nologin liveagent \
    && install -d -o liveagent -g liveagent -m 0700 /var/lib/liveagent

# 从 backend-builder 阶段复制 Rust 二进制
COPY --from=backend-builder /out/target/release/backend /usr/local/bin/backend

USER liveagent

# 后端直接认环境变量（PORT、LIVEAGENT_BACKEND_PASSWORD、LIVEAGENT_TLS_CERT/KEY
# 也可覆盖），不再需要 entrypoint 脚本翻译。
# pi 走 PATH（上面 npm -g 装的），需要换实现时用 LIVEAGENT_PI_BIN 覆盖。
#
# HOME 显式指到数据卷：pi 会读写 `~/.pi`（设置、扩展发现）。原先这个用户的
# home 是 /nonexistent，Node 程序往那儿写就是 EACCES。指到 /var/lib/liveagent
# 顺带让 pi 的配置跟会话文件一起持久化。
ENV LIVEAGENT_DATA_DIR=/var/lib/liveagent \
    HOME=/var/lib/liveagent

VOLUME ["/var/lib/liveagent"]

EXPOSE 8443

ENTRYPOINT ["/usr/local/bin/backend"]
