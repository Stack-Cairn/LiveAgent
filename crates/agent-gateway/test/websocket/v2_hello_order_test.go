package websocket_test

import (
	"net/http"
	"runtime"
	"sync"
	"testing"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/protocol/pbws"
	"github.com/liveagent/agent-gateway/internal/session"
)

// The hello reply used to be queued on the data lane while heartbeats and history
// recovery status ride the control lane. The write loop picks between two ready lanes
// at random, so a status published around the handshake could reach the client before
// authentication was acknowledged (a K-brain-backed gateway publishes one right after
// start, which is how CI caught it). The window needs the write loop to be scheduled
// late, so this end-to-end guard rarely fails on the old code; the lane-level tests in
// internal/transport/wscore pin the ordering deterministically.
func TestV2HelloReplyPrecedesControlLaneFrames(t *testing.T) {
	cfg := newV2TestConfig()
	sm := session.NewManager()
	srv := pbws.NewServer(cfg, sm, nil)
	defer srv.Close()
	mux := http.NewServeMux()
	mux.Handle("/ws/v2", srv.BrowserHandler())

	stop := make(chan struct{})
	var publisher sync.WaitGroup
	publisher.Add(1)
	go func() {
		defer publisher.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			sm.IngestRemoteHistoryStatus("hello-order-agent", &gatewayv2.HistorySyncStatus{
				SourceId:   "hello-order-source",
				Generation: "generation-1",
			})
			runtime.Gosched()
		}
	}()
	defer func() {
		close(stop)
		publisher.Wait()
	}()

	for round := 1; round <= 100; round++ {
		browser, cleanup := dialV2Path(t, mux, "/ws/v2")
		sendProtoFrame(t, browser, &gatewayv2.WebClientFrame{
			RequestId: "hello-1",
			Payload: &gatewayv2.WebClientFrame_Hello{Hello: &gatewayv2.ClientHello{
				ProtocolVersion: pbws.ProtocolVersion,
				Role:            gatewayv2.ClientRole_CLIENT_ROLE_BROWSER,
				Token:           cfg.Token,
				ClientName:      "webui-test",
			}},
		})
		first := receiveWebFrameRaw(t, browser)
		cleanup()
		if hello := first.GetHello(); hello == nil || !hello.GetOk() {
			t.Fatalf("round %d: first frame after hello is %T, want the hello reply", round, first.GetPayload())
		}
	}
}
