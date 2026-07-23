package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/liveagent/agent-gateway/internal/auth/agenttoken"
	"github.com/liveagent/agent-gateway/internal/config"
	"github.com/liveagent/agent-gateway/internal/db"
	"github.com/liveagent/agent-gateway/internal/observability"
	"github.com/liveagent/agent-gateway/internal/server"
	"github.com/liveagent/agent-gateway/internal/session"
)

// fatal 记录错误并以非零码退出（slog 没有 Fatal 级别，集中在此处理）。
func fatal(msg string, args ...any) {
	slog.Error(msg, args...)
	os.Exit(1)
}

func main() {
	observability.SetupLogging()
	cfg := config.Load()
	sm := session.NewManager()

	// 统一连接池：库由 internal/db 打开并集中管理，各持久化子系统在共享池上
	// 初始化自己的表；main 持有生命周期（退出时统一关闭）。
	database, err := db.Open(cfg.AgentDB)
	if err != nil {
		fatal("open gateway db failed", "path", cfg.AgentDB, "err", err)
	}
	defer func() { _ = database.Close() }()

	tokens, err := agenttoken.NewStore(database)
	if err != nil {
		fatal("init agent token store failed", "err", err)
	}
	slog.Info("agent registry db ready", "path", cfg.AgentDB)
	slog.Info("agent authentication accepts gateway token or per-agent token")

	httpServer := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           server.NewHTTPServer(cfg, sm, tokens),
		ReadHeaderTimeout: 10 * time.Second,
		// 空闲 keep-alive 连接必须回收，否则 REST/静态资源访问方挂住连接会把 fd
		// 慢性耗尽到 ulimit。刻意不设全局 Read/WriteTimeout：流式上传与隧道长响应
		// 需要；WS 连接已被 hijack、自管理超时，不受影响。
		IdleTimeout: 120 * time.Second,
	}

	errCh := make(chan error, 1)

	go func() {
		slog.Info("HTTP listening", "addr", cfg.HTTPAddr)
		var serveErr error
		if cfg.TLSCert != "" || cfg.TLSKey != "" {
			serveErr = httpServer.ListenAndServeTLS(cfg.TLSCert, cfg.TLSKey)
		} else {
			serveErr = httpServer.ListenAndServe()
		}
		if serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			errCh <- serveErr
		}
	}()

	signalCh := make(chan os.Signal, 1)
	signal.Notify(signalCh, syscall.SIGINT, syscall.SIGTERM)

	select {
	case sig := <-signalCh:
		slog.Info("received signal, shutting down", "signal", sig.String())
	case err := <-errCh:
		fatal("server error", "err", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := httpServer.Shutdown(ctx); err != nil {
		slog.Warn("http shutdown error", "err", err)
	}
}
