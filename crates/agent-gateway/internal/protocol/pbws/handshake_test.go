package pbws

import (
	"testing"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

func TestServerHelloAdvertisesChatIngressV1(t *testing.T) {
	hello := (&Server{}).serverHello(true, "", "session-1", 1024)

	if got := hello.GetCapabilities(); len(got) != 1 || got[0] != gatewayv2.ChatIngressV1Capability {
		t.Fatalf("server hello capabilities = %v, want [%q]", got, gatewayv2.ChatIngressV1Capability)
	}
}
