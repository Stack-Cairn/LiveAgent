package config

import (
	"flag"
	"io"
	"os"
	"testing"
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

func TestLoadUsesRailwayPortForHTTPDefault(t *testing.T) {
	t.Setenv("PORT", "8080")
	t.Setenv("LIVEAGENT_GATEWAY_TOKEN", "dev-token")

	resetFlagsForTest(t)
	cfg := Load()

	if cfg.HTTPAddr != ":8080" {
		t.Fatalf("HTTPAddr = %q, want :8080", cfg.HTTPAddr)
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
