package config

import (
	"flag"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const DefaultMaxMessageBytes = 64 * 1024 * 1024

// DefaultModelCatalogURL is the runtime model catalog published by
// .github/workflows/publish-model-catalog.yml.
const DefaultModelCatalogURL = "https://raw.githubusercontent.com/Stack-Cairn/LiveAgent/data/model-catalog/model-catalog.v1.json"

// 三条 v2 链路并发连接上限的默认值；浏览器/终端按"每 Agent 数个会话"的
// 使用形态放大（100 Agent × 若干浏览器页签/终端页）。
const (
	DefaultMaxAgentConnections    = 256
	DefaultMaxBrowserConnections  = 128
	DefaultMaxTerminalConnections = 512
)

type Config struct {
	// Legacy opt-in that reuses KBrainURL/KBrainToken for Image Studio. Prefer the
	// image-specific pair below, which needs no switch and never enables the chat relay.
	ImageSingleUser bool
	// Loopback K-Brain that serves Image Studio under the desktop owner's local scope.
	ImageKBrainURL   string
	ImageKBrainToken string
	Token            string
	// InstanceNonce identifies a desktop-owned child, and is only returned to its authenticated owner.
	InstanceNonce string
	// AgentDB 是每 Agent 凭证 SQLite 数据库路径；默认自动创建于用户配置目录。
	AgentDB string
	// 三条 v2 链路的并发连接上限（升级前检查，超限 503）；0/负值回落默认。
	// 默认值按 100+ 桌面 Agent 的目标规模取整。
	MaxAgentConnections      int
	MaxBrowserConnections    int
	MaxTerminalConnections   int
	HTTPAddr                 string
	TLSCert                  string
	TLSKey                   string
	RequestTimeout           time.Duration
	ChatPrepareTimeout       time.Duration
	ChatDeliveryTimeout      time.Duration
	ChatStartTimeout         time.Duration
	ChatRenderStartTimeout   time.Duration
	HeartbeatPeriod          time.Duration
	WebSocketHeartbeatPeriod time.Duration
	WebSocketHeartbeatGrace  time.Duration
	WebSocketWriteTimeout    time.Duration
	WebSocketWriteQueueSize  int
	MaxMessageBytes          int
	RelayBufferSeconds       int
	// K-brain remote target turns Gateway chat into canonical K-brain HTTP/SSE.
	KBrainURL      string
	KBrainToken    string
	KBrainAgentID  string
	KBrainProvider string
	KBrainModel    string
	// ModelCatalogURL is the upstream runtime model catalog served at
	// /api/public/model-catalog; empty disables the proxy.
	ModelCatalogURL string
}

func Load() *Config {
	cfg := &Config{}
	cfg.InstanceNonce = os.Getenv("LIVEAGENT_GATEWAY_INSTANCE_NONCE")

	flag.BoolVar(&cfg.ImageSingleUser, "image-single-user", getenv("LIVEAGENT_GATEWAY_IMAGE_SINGLE_USER", "") == "true", "enable single-owner Image Studio on an authenticated loopback K-Brain backend")
	flag.StringVar(&cfg.ImageKBrainURL, "image-kbrain-url", getenv("LIVEAGENT_GATEWAY_IMAGE_KBRAIN_URL", ""), "loopback K-Brain URL serving Image Studio (enables image routes when set with its token)")
	// Secret flags default to empty and fall back to the environment after Parse, so
	// -h / usage output never prints a token read from the environment.
	flag.StringVar(&cfg.ImageKBrainToken, "image-kbrain-token", "", "bearer token for the Image Studio K-Brain (or LIVEAGENT_GATEWAY_IMAGE_KBRAIN_TOKEN)")
	flag.StringVar(&cfg.Token, "token", "", "gateway authentication token (or LIVEAGENT_GATEWAY_TOKEN)")
	flag.StringVar(&cfg.AgentDB, "agent-db", getenv("LIVEAGENT_GATEWAY_AGENT_DB", defaultAgentDBPath()), "per-agent token SQLite database path (auto-created by default)")
	flag.IntVar(&cfg.MaxAgentConnections, "max-agent-connections", getenvInt("LIVEAGENT_GATEWAY_MAX_AGENT_CONNECTIONS", DefaultMaxAgentConnections), "maximum concurrent desktop agent connections")
	flag.IntVar(&cfg.MaxBrowserConnections, "max-browser-connections", getenvInt("LIVEAGENT_GATEWAY_MAX_BROWSER_CONNECTIONS", DefaultMaxBrowserConnections), "maximum concurrent browser connections")
	flag.IntVar(&cfg.MaxTerminalConnections, "max-terminal-connections", getenvInt("LIVEAGENT_GATEWAY_MAX_TERMINAL_CONNECTIONS", DefaultMaxTerminalConnections), "maximum concurrent terminal data-plane connections")
	flag.StringVar(&cfg.HTTPAddr, "http-addr", getenv("LIVEAGENT_GATEWAY_HTTP_ADDR", defaultHTTPAddr()), "HTTP listen address")
	flag.StringVar(&cfg.TLSCert, "tls-cert", getenv("LIVEAGENT_GATEWAY_TLS_CERT", ""), "TLS certificate path")
	flag.StringVar(&cfg.TLSKey, "tls-key", getenv("LIVEAGENT_GATEWAY_TLS_KEY", ""), "TLS private key path")
	flag.StringVar(&cfg.ModelCatalogURL, "model-catalog-url", getenv("LIVEAGENT_GATEWAY_MODEL_CATALOG_URL", DefaultModelCatalogURL), "runtime model catalog served to WebUI at /api/public/model-catalog (\"off\" disables)")
	flag.DurationVar(&cfg.RequestTimeout, "request-timeout", getenvDuration("LIVEAGENT_GATEWAY_REQUEST_TIMEOUT", 2*time.Minute), "request timeout for non-streaming API calls")
	flag.DurationVar(&cfg.ChatPrepareTimeout, "chat-prepare-timeout", getenvDuration("LIVEAGENT_GATEWAY_CHAT_PREPARE_TIMEOUT", 2*time.Second), "timeout for the pre-submit desktop agent liveness probe")
	flag.DurationVar(&cfg.ChatDeliveryTimeout, "chat-delivery-timeout", getenvDuration("LIVEAGENT_GATEWAY_CHAT_DELIVERY_TIMEOUT", 5*time.Second), "timeout delivering an accepted chat command to the desktop agent stream")
	flag.DurationVar(&cfg.ChatStartTimeout, "chat-start-timeout", getenvDuration("LIVEAGENT_GATEWAY_CHAT_START_TIMEOUT", 5*time.Second), "initial timeout waiting for a delivered remote chat request to start")
	flag.DurationVar(&cfg.ChatRenderStartTimeout, "chat-render-start-timeout", getenvDuration("LIVEAGENT_GATEWAY_CHAT_RENDER_START_TIMEOUT", 10*time.Second), "additional timeout waiting for the desktop app to start a delivered remote chat request")
	flag.DurationVar(&cfg.HeartbeatPeriod, "heartbeat-period", getenvDuration("LIVEAGENT_GATEWAY_HEARTBEAT_PERIOD", 30*time.Second), "ping interval for agent connection")
	flag.DurationVar(&cfg.WebSocketHeartbeatPeriod, "websocket-heartbeat-period", getenvDuration("LIVEAGENT_GATEWAY_WS_HEARTBEAT_PERIOD", 15*time.Second), "ping interval for browser WebSocket connections")
	flag.DurationVar(&cfg.WebSocketHeartbeatGrace, "websocket-heartbeat-grace", getenvDuration("LIVEAGENT_GATEWAY_WS_HEARTBEAT_GRACE", 5*time.Second), "extra slack added to the browser WebSocket idle timeout (idle = 3x period + grace)")
	flag.DurationVar(&cfg.WebSocketWriteTimeout, "websocket-write-timeout", getenvDuration("LIVEAGENT_GATEWAY_WS_WRITE_TIMEOUT", 10*time.Second), "write timeout for browser WebSocket connections")
	flag.IntVar(&cfg.WebSocketWriteQueueSize, "websocket-write-queue-size", getenvInt("LIVEAGENT_GATEWAY_WS_WRITE_QUEUE_SIZE", 512), "write queue buffer size for browser WebSocket connections")
	flag.IntVar(
		&cfg.MaxMessageBytes,
		"max-message-bytes",
		getenvInt(
			"LIVEAGENT_GATEWAY_MAX_MESSAGE_BYTES",
			getenvInt("LIVEAGENT_GATEWAY_GRPC_MAX_MESSAGE_BYTES", DefaultMaxMessageBytes),
		),
		"maximum WebSocket protobuf message size in bytes",
	)
	flag.IntVar(&cfg.RelayBufferSeconds, "relay-buffer-seconds", getenvInt("LIVEAGENT_GATEWAY_RELAY_BUFFER_SECONDS", 30), "seconds of chat events to buffer for brief reconnections")
	flag.StringVar(&cfg.KBrainURL, "kbrain-url", getenv("LIVEAGENT_GATEWAY_KBRAIN_URL", ""), "K-brain backend URL for the remote chat target")
	flag.StringVar(&cfg.KBrainToken, "kbrain-token", "", "K-brain backend bearer token (or LIVEAGENT_GATEWAY_KBRAIN_TOKEN)")
	flag.StringVar(&cfg.KBrainAgentID, "kbrain-agent-id", getenv("LIVEAGENT_GATEWAY_KBRAIN_AGENT_ID", "kbrain"), "Gateway target id for K-brain remote chat")
	flag.StringVar(&cfg.KBrainProvider, "kbrain-provider", getenv("LIVEAGENT_GATEWAY_KBRAIN_PROVIDER", ""), "default K-brain provider for Gateway chat")
	flag.StringVar(&cfg.KBrainModel, "kbrain-model", getenv("LIVEAGENT_GATEWAY_KBRAIN_MODEL", ""), "default K-brain model for Gateway chat")
	os.Args = normalizeLegacyArgs(os.Args)
	flag.Parse()
	if strings.EqualFold(strings.TrimSpace(cfg.ModelCatalogURL), "off") {
		cfg.ModelCatalogURL = ""
	}
	for _, secret := range []struct {
		value *string
		env   string
	}{
		{&cfg.Token, "LIVEAGENT_GATEWAY_TOKEN"},
		{&cfg.KBrainToken, "LIVEAGENT_GATEWAY_KBRAIN_TOKEN"},
		{&cfg.ImageKBrainToken, "LIVEAGENT_GATEWAY_IMAGE_KBRAIN_TOKEN"},
	} {
		if *secret.value == "" {
			*secret.value = getenv(secret.env, "")
		}
	}

	cfg.Token = strings.TrimSpace(cfg.Token)
	cfg.AgentDB = strings.TrimSpace(cfg.AgentDB)
	// Agent 凭证数据库是网关始终启用的基础能力；即使启动参数显式传空，也
	// 回退到自动路径，不能通过空值关闭。
	if cfg.AgentDB == "" {
		cfg.AgentDB = defaultAgentDBPath()
	}
	cfg.TLSCert = strings.TrimSpace(cfg.TLSCert)
	cfg.TLSKey = strings.TrimSpace(cfg.TLSKey)
	cfg.KBrainURL = strings.TrimRight(strings.TrimSpace(cfg.KBrainURL), "/")
	cfg.ImageKBrainURL = strings.TrimRight(strings.TrimSpace(cfg.ImageKBrainURL), "/")
	cfg.ImageKBrainToken = strings.TrimSpace(cfg.ImageKBrainToken)
	cfg.KBrainToken = strings.TrimSpace(cfg.KBrainToken)
	cfg.KBrainAgentID = strings.TrimSpace(cfg.KBrainAgentID)
	cfg.KBrainProvider = strings.TrimSpace(cfg.KBrainProvider)
	cfg.KBrainModel = strings.TrimSpace(cfg.KBrainModel)

	if cfg.Token == "" {
		flag.Usage()
		panic("gateway token is required")
	}
	if cfg.MaxMessageBytes <= 0 {
		cfg.MaxMessageBytes = DefaultMaxMessageBytes
	}
	if cfg.MaxAgentConnections <= 0 {
		cfg.MaxAgentConnections = DefaultMaxAgentConnections
	}
	if cfg.MaxBrowserConnections <= 0 {
		cfg.MaxBrowserConnections = DefaultMaxBrowserConnections
	}
	if cfg.MaxTerminalConnections <= 0 {
		cfg.MaxTerminalConnections = DefaultMaxTerminalConnections
	}
	if cfg.ChatPrepareTimeout <= 0 {
		cfg.ChatPrepareTimeout = 2 * time.Second
	}
	if cfg.ChatDeliveryTimeout <= 0 {
		cfg.ChatDeliveryTimeout = 5 * time.Second
	}
	if cfg.ChatStartTimeout <= 0 {
		cfg.ChatStartTimeout = 5 * time.Second
	}
	if cfg.ChatRenderStartTimeout <= 0 {
		cfg.ChatRenderStartTimeout = 10 * time.Second
	}
	if cfg.WebSocketHeartbeatPeriod <= 0 {
		cfg.WebSocketHeartbeatPeriod = 15 * time.Second
	}
	if cfg.WebSocketHeartbeatGrace <= 0 {
		cfg.WebSocketHeartbeatGrace = 5 * time.Second
	}
	if cfg.WebSocketWriteTimeout <= 0 {
		cfg.WebSocketWriteTimeout = 10 * time.Second
	}
	if cfg.WebSocketWriteQueueSize <= 0 {
		cfg.WebSocketWriteQueueSize = 512
	}
	if cfg.RelayBufferSeconds <= 0 {
		cfg.RelayBufferSeconds = 30
	}

	return cfg
}

// normalizeLegacyArgs 在进入新版 FlagSet 前统一清理已删除参数。旧名称不再注册、
// 不出现在帮助中，也不会恢复 v1/gRPC 或离线命令队列；真正未知的参数仍由 flag
// 正常拒绝。消息大小参数仍有对应语义，因此转换为新名称；显式的新名称优先。
func normalizeLegacyArgs(args []string) []string {
	if len(args) == 0 {
		return args
	}

	hasCurrentMessageLimit := false
	for _, arg := range args[1:] {
		if arg == "-max-message-bytes" || arg == "--max-message-bytes" ||
			strings.HasPrefix(arg, "-max-message-bytes=") ||
			strings.HasPrefix(arg, "--max-message-bytes=") {
			hasCurrentMessageLimit = true
			break
		}
	}

	normalized := make([]string, 0, len(args))
	normalized = append(normalized, args[0])
	for index := 1; index < len(args); index++ {
		arg := args[index]
		if arg == "--" {
			normalized = append(normalized, args[index:]...)
			break
		}
		switch {
		case arg == "-grpc-addr" || arg == "--grpc-addr" ||
			arg == "-command-queue-timeout" || arg == "--command-queue-timeout":
			if index+1 < len(args) {
				index++
			}
		case strings.HasPrefix(arg, "-grpc-addr=") ||
			strings.HasPrefix(arg, "--grpc-addr=") ||
			strings.HasPrefix(arg, "-command-queue-timeout=") ||
			strings.HasPrefix(arg, "--command-queue-timeout="):
			continue
		case arg == "-grpc-max-message-bytes" || arg == "--grpc-max-message-bytes":
			if index+1 < len(args) {
				if !hasCurrentMessageLimit {
					normalized = append(normalized, "-max-message-bytes", args[index+1])
				}
				index++
			}
		case strings.HasPrefix(arg, "-grpc-max-message-bytes=") ||
			strings.HasPrefix(arg, "--grpc-max-message-bytes="):
			if !hasCurrentMessageLimit {
				value := strings.SplitN(arg, "=", 2)[1]
				normalized = append(normalized, "-max-message-bytes="+value)
			}
		default:
			normalized = append(normalized, arg)
		}
	}
	return normalized
}

func defaultAgentDBPath() string {
	if dataDir := strings.TrimSpace(os.Getenv("LIVEAGENT_GATEWAY_DATA_DIR")); dataDir != "" {
		return filepath.Join(dataDir, "gateway.db")
	}
	if configDir, err := os.UserConfigDir(); err == nil && strings.TrimSpace(configDir) != "" {
		return filepath.Join(configDir, "liveagent", "gateway.db")
	}
	return filepath.Join(".", "liveagent-gateway.db")
}

func getenv(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func defaultHTTPAddr() string {
	port := strings.TrimSpace(os.Getenv("PORT"))
	if port == "" {
		return ":443"
	}
	if strings.HasPrefix(port, ":") {
		return port
	}
	return ":" + port
}

func getenvDuration(key string, fallback time.Duration) time.Duration {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	parsed, err := time.ParseDuration(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func getenvInt(key string, fallback int) int {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 {
		return fallback
	}
	return parsed
}
