// Package observability 汇集网关的可观测性基础设施（slog 初始化与 v2 协议打点）。
package observability

import (
	"log/slog"
	"os"
)

// SetupLogging 安装进程级默认 slog logger：单行 key=value 输出到 stderr，
// 对容器/journald 日志采集友好，结构化字段便于检索与告警。
func SetupLogging() {
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, nil)))
}
