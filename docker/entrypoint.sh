#!/usr/bin/env bash
# LiveAgent headless 启动入口
#
# 1) mise 自举：确保全局配置里声明的工具版本都已安装。
#    - 镜像预装的版本（core/full）已存在，这里秒过；
#    - 用户通过环境变量（如 MISE_JAVA_VERSION=temurin-8）切换到的
#      缺失版本会在此自动补装（懒加载，需出网，补装内容持久化在
#      MISE_DATA_DIR 卷上，只付一次下载）。
# 2) 注入 mise 环境（PATH / JAVA_HOME / MISE_* 等），再启动主进程，
#    使 docker exec 进入的 shell 直接具备完整工具链。
set -euo pipefail

if command -v mise >/dev/null 2>&1; then
  mise install -y >/dev/null 2>&1 \
    || echo "[entrypoint] warning: mise install failed, continuing with preinstalled tools" >&2
  eval "$(mise env --shell bash)" >/dev/null 2>&1 || true
fi

exec /usr/local/bin/liveagent "$@"
