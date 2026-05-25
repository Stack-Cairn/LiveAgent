package config

import (
	"flag"
	"os"
	"strconv"
	"strings"
	"time"
)

const DefaultGRPCMaxMessageBytes = 64 * 1024 * 1024

type Config struct {
	Token                    string
	GRPCAddr                 string
	HTTPAddr                 string
	TLSCert                  string
	TLSKey                   string
	RequestTimeout           time.Duration
	HeartbeatPeriod          time.Duration
	WebSocketHeartbeatPeriod time.Duration
	WebSocketWriteTimeout    time.Duration
	GRPCMaxMessageBytes      int
}

func Load() *Config {
	cfg := &Config{}

	flag.StringVar(&cfg.Token, "token", getenv("LIVEAGENT_GATEWAY_TOKEN", ""), "shared authentication token")
	flag.StringVar(&cfg.GRPCAddr, "grpc-addr", getenv("LIVEAGENT_GATEWAY_GRPC_ADDR", ":50051"), "gRPC listen address")
	flag.StringVar(&cfg.HTTPAddr, "http-addr", getenv("LIVEAGENT_GATEWAY_HTTP_ADDR", defaultHTTPAddr()), "HTTP listen address")
	flag.StringVar(&cfg.TLSCert, "tls-cert", getenv("LIVEAGENT_GATEWAY_TLS_CERT", ""), "TLS certificate path")
	flag.StringVar(&cfg.TLSKey, "tls-key", getenv("LIVEAGENT_GATEWAY_TLS_KEY", ""), "TLS private key path")
	flag.DurationVar(&cfg.RequestTimeout, "request-timeout", getenvDuration("LIVEAGENT_GATEWAY_REQUEST_TIMEOUT", 2*time.Minute), "request timeout for non-streaming API calls")
	flag.DurationVar(&cfg.HeartbeatPeriod, "heartbeat-period", getenvDuration("LIVEAGENT_GATEWAY_HEARTBEAT_PERIOD", 30*time.Second), "ping interval for agent connection")
	flag.DurationVar(&cfg.WebSocketHeartbeatPeriod, "websocket-heartbeat-period", getenvDuration("LIVEAGENT_GATEWAY_WS_HEARTBEAT_PERIOD", 15*time.Second), "ping interval for browser WebSocket connections")
	flag.DurationVar(&cfg.WebSocketWriteTimeout, "websocket-write-timeout", getenvDuration("LIVEAGENT_GATEWAY_WS_WRITE_TIMEOUT", 10*time.Second), "write timeout for browser WebSocket connections")
	flag.IntVar(&cfg.GRPCMaxMessageBytes, "grpc-max-message-bytes", getenvInt("LIVEAGENT_GATEWAY_GRPC_MAX_MESSAGE_BYTES", DefaultGRPCMaxMessageBytes), "maximum gRPC message size in bytes")
	flag.Parse()

	cfg.Token = strings.TrimSpace(cfg.Token)
	cfg.TLSCert = strings.TrimSpace(cfg.TLSCert)
	cfg.TLSKey = strings.TrimSpace(cfg.TLSKey)

	if cfg.Token == "" {
		flag.Usage()
		panic("gateway token is required")
	}
	if cfg.GRPCMaxMessageBytes <= 0 {
		cfg.GRPCMaxMessageBytes = DefaultGRPCMaxMessageBytes
	}
	if cfg.WebSocketHeartbeatPeriod <= 0 {
		cfg.WebSocketHeartbeatPeriod = 15 * time.Second
	}
	if cfg.WebSocketWriteTimeout <= 0 {
		cfg.WebSocketWriteTimeout = 10 * time.Second
	}

	return cfg
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
