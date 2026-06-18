package main

import (
	"context"
	"errors"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/reflection"

	"github.com/liveagent/agent-gateway/internal/auth"
	"github.com/liveagent/agent-gateway/internal/config"
	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
	"github.com/liveagent/agent-gateway/internal/server"
	"github.com/liveagent/agent-gateway/internal/session"
)

const grpcShutdownTimeout = 3 * time.Second

func main() {
	cfg := config.Load()
	chatEventStore, err := session.OpenSQLiteChatEventStore(cfg.ChatEventStorePath)
	if err != nil {
		log.Fatalf("open chat event store: %v", err)
	}
	defer func() {
		if err := chatEventStore.Close(); err != nil {
			log.Printf("close chat event store: %v", err)
		}
	}()
	sm, err := session.NewManagerWithChatEventStore(chatEventStore)
	if err != nil {
		log.Fatalf("initialize session manager: %v", err)
	}

	grpcServer, err := newGRPCServer(cfg, sm)
	if err != nil {
		log.Fatalf("create gRPC server: %v", err)
	}

	grpcListener, err := net.Listen("tcp", cfg.GRPCAddr)
	if err != nil {
		log.Fatalf("listen gRPC: %v", err)
	}

	httpServer := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           server.NewHTTPServer(cfg, sm),
		ReadHeaderTimeout: 10 * time.Second,
	}

	errCh := make(chan error, 2)

	go func() {
		log.Printf("gRPC listening on %s", cfg.GRPCAddr)
		if serveErr := grpcServer.Serve(grpcListener); serveErr != nil && !errors.Is(serveErr, grpc.ErrServerStopped) {
			errCh <- serveErr
		}
	}()

	go func() {
		log.Printf("HTTP listening on %s", cfg.HTTPAddr)
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
		log.Printf("received signal %s, shutting down", sig)
	case err := <-errCh:
		log.Fatalf("server error: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	httpShutdownErrCh := make(chan error, 1)
	go func() {
		httpShutdownErrCh <- httpServer.Shutdown(ctx)
	}()

	if forced := shutdownGRPCServer(grpcServer, grpcShutdownTimeout); forced {
		log.Printf("gRPC graceful shutdown timed out after %s, forcing stop", grpcShutdownTimeout)
	}

	if err := <-httpShutdownErrCh; err != nil {
		log.Printf("http shutdown error: %v", err)
	}
}

func newGRPCServer(cfg *config.Config, sm *session.Manager) (*grpc.Server, error) {
	options := []grpc.ServerOption{
		grpc.MaxRecvMsgSize(cfg.GRPCMaxMessageBytes),
		grpc.MaxSendMsgSize(cfg.GRPCMaxMessageBytes),
		grpc.UnaryInterceptor(auth.GRPCUnaryInterceptor(cfg.Token)),
		grpc.StreamInterceptor(auth.GRPCStreamInterceptor(cfg.Token)),
	}
	if cfg.TLSCert != "" || cfg.TLSKey != "" {
		creds, err := credentials.NewServerTLSFromFile(cfg.TLSCert, cfg.TLSKey)
		if err != nil {
			return nil, err
		}
		options = append(options, grpc.Creds(creds))
	}

	grpcServer := grpc.NewServer(options...)
	gatewayv1.RegisterAgentGatewayServer(grpcServer, server.NewGRPCServer(cfg, sm))
	reflection.Register(grpcServer)
	return grpcServer, nil
}
