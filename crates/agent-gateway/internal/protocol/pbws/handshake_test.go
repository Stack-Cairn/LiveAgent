package pbws

import (
	"testing"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

func TestServerHelloAdvertisesGatewayCapabilities(t *testing.T) {
	hello := (&Server{}).serverHello(true, "", "session-1", 1024)

	got := hello.GetCapabilities()
	if len(got) != 2 || got[0] != gatewayv2.ChatIngressV1Capability || got[1] != gatewayv2.SttStreamV1Capability {
		t.Fatalf("server hello capabilities = %v", got)
	}
}
