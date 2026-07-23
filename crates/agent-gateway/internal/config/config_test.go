package config

import (
	"flag"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestLoadNormalizesTokenAndTLSPaths(t *testing.T) {
	t.Setenv("LIVEAGENT_GATEWAY_TOKEN", "  secret-token\r\n")
	t.Setenv("LIVEAGENT_GATEWAY_TLS_CERT", " cert.pem ")
	t.Setenv("LIVEAGENT_GATEWAY_TLS_KEY", "\tkey.pem\r\n")
	resetFlagsForTest(t)
	cfg := Load()
	if cfg.Token != "secret-token" {
		t.Fatalf("Token = %q, want %q", cfg.Token, "secret-token")
	}
	if cfg.TLSCert != "cert.pem" {
		t.Fatalf("TLSCert = %q, want %q", cfg.TLSCert, "cert.pem")
	}
	if cfg.TLSKey != "key.pem" {
		t.Fatalf("TLSKey = %q, want %q", cfg.TLSKey, "key.pem")
	}
}

func TestLoadWebSocketHeartbeatGrace(t *testing.T) {
	t.Setenv("LIVEAGENT_GATEWAY_TOKEN", "dev-token")
	resetFlagsForTest(t)
	cfg := Load()
	if cfg.WebSocketHeartbeatGrace != 5*time.Second {
		t.Fatalf("WebSocketHeartbeatGrace default = %s, want 5s", cfg.WebSocketHeartbeatGrace)
	}

	t.Setenv("LIVEAGENT_GATEWAY_WS_HEARTBEAT_GRACE", "45s")
	resetFlagsForTest(t)
	cfg = Load()
	if cfg.WebSocketHeartbeatGrace != 45*time.Second {
		t.Fatalf("WebSocketHeartbeatGrace = %s, want 45s", cfg.WebSocketHeartbeatGrace)
	}

	t.Setenv("LIVEAGENT_GATEWAY_WS_HEARTBEAT_GRACE", "-3s")
	resetFlagsForTest(t)
	cfg = Load()
	if cfg.WebSocketHeartbeatGrace != 5*time.Second {
		t.Fatalf("WebSocketHeartbeatGrace with negative env = %s, want 5s fallback", cfg.WebSocketHeartbeatGrace)
	}
}

func TestLoadChatTimeouts(t *testing.T) {
	t.Setenv("LIVEAGENT_GATEWAY_TOKEN", "dev-token")
	resetFlagsForTest(t)
	cfg := Load()
	if cfg.ChatPrepareTimeout != 2*time.Second {
		t.Fatalf("ChatPrepareTimeout default = %s, want 2s", cfg.ChatPrepareTimeout)
	}
	if cfg.ChatDeliveryTimeout != 5*time.Second {
		t.Fatalf("ChatDeliveryTimeout default = %s, want 5s", cfg.ChatDeliveryTimeout)
	}
	if cfg.ChatStartTimeout != 5*time.Second {
		t.Fatalf("ChatStartTimeout default = %s, want 5s", cfg.ChatStartTimeout)
	}
	if cfg.ChatRenderStartTimeout != 10*time.Second {
		t.Fatalf("ChatRenderStartTimeout default = %s, want 10s", cfg.ChatRenderStartTimeout)
	}

	t.Setenv("LIVEAGENT_GATEWAY_CHAT_PREPARE_TIMEOUT", "750ms")
	t.Setenv("LIVEAGENT_GATEWAY_CHAT_DELIVERY_TIMEOUT", "3s")
	t.Setenv("LIVEAGENT_GATEWAY_CHAT_START_TIMEOUT", "4s")
	t.Setenv("LIVEAGENT_GATEWAY_CHAT_RENDER_START_TIMEOUT", "8s")
	resetFlagsForTest(t)
	cfg = Load()
	if cfg.ChatPrepareTimeout != 750*time.Millisecond ||
		cfg.ChatDeliveryTimeout != 3*time.Second ||
		cfg.ChatStartTimeout != 4*time.Second ||
		cfg.ChatRenderStartTimeout != 8*time.Second {
		t.Fatalf("custom chat timeouts = prepare:%s delivery:%s start:%s render:%s",
			cfg.ChatPrepareTimeout,
			cfg.ChatDeliveryTimeout,
			cfg.ChatStartTimeout,
			cfg.ChatRenderStartTimeout,
		)
	}

	t.Setenv("LIVEAGENT_GATEWAY_CHAT_PREPARE_TIMEOUT", "-1s")
	t.Setenv("LIVEAGENT_GATEWAY_CHAT_DELIVERY_TIMEOUT", "0s")
	t.Setenv("LIVEAGENT_GATEWAY_CHAT_START_TIMEOUT", "-1s")
	t.Setenv("LIVEAGENT_GATEWAY_CHAT_RENDER_START_TIMEOUT", "-1s")
	resetFlagsForTest(t)
	cfg = Load()
	if cfg.ChatPrepareTimeout != 2*time.Second ||
		cfg.ChatDeliveryTimeout != 5*time.Second ||
		cfg.ChatStartTimeout != 5*time.Second ||
		cfg.ChatRenderStartTimeout != 10*time.Second {
		t.Fatalf("normalized chat timeouts = prepare:%s delivery:%s start:%s render:%s",
			cfg.ChatPrepareTimeout,
			cfg.ChatDeliveryTimeout,
			cfg.ChatStartTimeout,
			cfg.ChatRenderStartTimeout,
		)
	}
}

func TestLoadUsesRailwayPortForHTTPDefault(t *testing.T) {
	t.Setenv("PORT", "8080")
	t.Setenv("LIVEAGENT_GATEWAY_TOKEN", "dev-token")

	resetFlagsForTest(t)
	cfg := Load()

	if cfg.HTTPAddr != ":8080" {
		t.Fatalf("HTTPAddr = %q, want :8080", cfg.HTTPAddr)
	}
}

func TestLoadDefaultsToAutoDB(t *testing.T) {
	t.Setenv("LIVEAGENT_GATEWAY_TOKEN", "dev-token")
	dataDir := t.TempDir()
	t.Setenv("LIVEAGENT_GATEWAY_DATA_DIR", dataDir)
	resetFlagsForTest(t)
	cfg := Load()
	if cfg.AgentDB != filepath.Join(dataDir, "gateway.db") {
		t.Fatalf("AgentDB = %q, want automatic data-dir path", cfg.AgentDB)
	}
}

func TestLoadEmptyAgentDBStillUsesAutomaticPath(t *testing.T) {
	t.Setenv("LIVEAGENT_GATEWAY_TOKEN", "dev-token")
	dataDir := t.TempDir()
	t.Setenv("LIVEAGENT_GATEWAY_DATA_DIR", dataDir)
	resetFlagsForTest(t)
	os.Args = []string{"gateway", "-agent-db", ""}
	cfg := Load()
	if cfg.AgentDB != filepath.Join(dataDir, "gateway.db") {
		t.Fatalf("AgentDB = %q, want automatic path when explicitly empty", cfg.AgentDB)
	}
}

func TestLoadAcceptsLegacyFlagsAndMapsMessageLimit(t *testing.T) {
	t.Setenv("LIVEAGENT_GATEWAY_TOKEN", "dev-token")
	resetFlagsForTest(t)
	os.Args = []string{
		"gateway",
		"-grpc-addr", ":50051",
		"-grpc-max-message-bytes", "33554432",
		"-command-queue-timeout", "45s",
	}

	cfg := Load()
	if cfg.MaxMessageBytes != 32*1024*1024 {
		t.Fatalf("MaxMessageBytes = %d, want legacy flag value", cfg.MaxMessageBytes)
	}
	for _, name := range []string{"grpc-addr", "grpc-max-message-bytes", "command-queue-timeout"} {
		if flag.CommandLine.Lookup(name) != nil {
			t.Fatalf("legacy flag %q should not be registered", name)
		}
	}
}

func TestLoadCurrentMessageLimitTakesPriorityOverLegacyFlag(t *testing.T) {
	t.Setenv("LIVEAGENT_GATEWAY_TOKEN", "dev-token")
	resetFlagsForTest(t)
	os.Args = []string{
		"gateway",
		"-max-message-bytes", "16777216",
		"-grpc-max-message-bytes", "33554432",
	}

	cfg := Load()
	if cfg.MaxMessageBytes != 16*1024*1024 {
		t.Fatalf("MaxMessageBytes = %d, want current flag value", cfg.MaxMessageBytes)
	}
}

func TestLoadMapsLegacyMessageLimitEnvironment(t *testing.T) {
	t.Setenv("LIVEAGENT_GATEWAY_TOKEN", "dev-token")
	t.Setenv("LIVEAGENT_GATEWAY_GRPC_MAX_MESSAGE_BYTES", "33554432")
	resetFlagsForTest(t)

	cfg := Load()
	if cfg.MaxMessageBytes != 32*1024*1024 {
		t.Fatalf("MaxMessageBytes = %d, want legacy environment value", cfg.MaxMessageBytes)
	}
}

func resetFlagsForTest(t *testing.T) {
	t.Helper()
	oldCommandLine := flag.CommandLine
	oldArgs := os.Args
	t.Cleanup(func() {
		flag.CommandLine = oldCommandLine
		os.Args = oldArgs
	})

	flag.CommandLine = flag.NewFlagSet("gateway", flag.ContinueOnError)
	flag.CommandLine.SetOutput(io.Discard)
	os.Args = []string{"gateway"}
}
