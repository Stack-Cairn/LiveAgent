#!/bin/sh
# 容器入口：把环境变量翻译成 agent-backend 的命令行参数。
#
# 后端自己只认 argv（main.rs 手写参数解析，没有 env 支持）。但容器平台
# （Railway 等）只会给环境变量，而且 ENTRYPOINT 里写死参数会有两个后果：
#   1. 不传 --password 后端每次启动随机生成一个新密码，只打到 stderr ——
#      每次重启客户端都要去翻部署日志，等于不可用；
#   2. 平台注入的 $PORT 会被忽略，健康检查打不到监听端口。
# 这层薄壳解决这两件事，不需要动 Rust 侧。
#
# 必须 exec：agent-backend 自己处理 SIGTERM 来 kill Node 子进程，
# 中间夹一个 sh 会把信号吞掉，容器停止时留下孤儿 Node 进程。

set -eu

set -- --port "${PORT:-8443}" --engine-bundle "${LIVEAGENT_ENGINE_BUNDLE:-/opt/liveagent/engine}"

# 不设就退回随机密码（本地 smoke 测试就是这么跑的，/healthz 不需要鉴权）。
if [ -n "${LIVEAGENT_BACKEND_PASSWORD:-}" ]; then
	set -- "$@" --password "$LIVEAGENT_BACKEND_PASSWORD"
fi

# TLS 两个都给才启用；只给一个是配置写错了，早失败好过静默降级成明文。
if [ -n "${LIVEAGENT_TLS_CERT:-}" ] || [ -n "${LIVEAGENT_TLS_KEY:-}" ]; then
	if [ -z "${LIVEAGENT_TLS_CERT:-}" ] || [ -z "${LIVEAGENT_TLS_KEY:-}" ]; then
		echo "LIVEAGENT_TLS_CERT 和 LIVEAGENT_TLS_KEY 必须同时设置" >&2
		exit 1
	fi
	set -- "$@" --tls-cert "$LIVEAGENT_TLS_CERT" --tls-key "$LIVEAGENT_TLS_KEY"
fi

exec agent-backend "$@"
