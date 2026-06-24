package server

import (
	"context"
	"net"
	"testing"
	"time"

	"github.com/liveagent/agent-gateway/internal/config"
	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
	"github.com/liveagent/agent-gateway/internal/session"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/test/bufconn"
)

func TestAgentTerminalConnectSendsReadyFrame(t *testing.T) {
	listener := bufconn.Listen(1024 * 1024)
	grpcServer := grpc.NewServer()
	gatewayv1.RegisterAgentGatewayServer(grpcServer, NewGRPCServer(&config.Config{}, session.NewManager()))
	t.Cleanup(func() {
		grpcServer.Stop()
		_ = listener.Close()
	})

	serveErr := make(chan error, 1)
	go func() {
		serveErr <- grpcServer.Serve(listener)
	}()

	conn, err := grpc.NewClient(
		"passthrough:///bufnet",
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
			return listener.DialContext(ctx)
		}),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		t.Fatalf("dial bufconn gRPC: %v", err)
	}
	t.Cleanup(func() {
		_ = conn.Close()
	})

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	stream, err := gatewayv1.NewAgentGatewayClient(conn).AgentTerminalConnect(ctx)
	if err != nil {
		t.Fatalf("open terminal stream: %v", err)
	}
	frame, err := stream.Recv()
	if err != nil {
		t.Fatalf("receive terminal ready frame: %v", err)
	}
	if frame.GetKind() != "detach" {
		t.Fatalf("ready frame kind = %q, want detach", frame.GetKind())
	}
	if streamID := frame.GetStreamId(); len(streamID) < len("gateway-ready-") || streamID[:len("gateway-ready-")] != "gateway-ready-" {
		t.Fatalf("ready frame stream id = %q, want gateway-ready-*", streamID)
	}

	grpcServer.Stop()
	select {
	case err := <-serveErr:
		if err != nil && err != grpc.ErrServerStopped {
			t.Fatalf("Serve returned error: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("gRPC server did not stop")
	}
}
