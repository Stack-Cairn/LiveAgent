package websocket_test

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"google.golang.org/protobuf/proto"

	"github.com/liveagent/agent-gateway/internal/auth/agenttoken"
	"github.com/liveagent/agent-gateway/internal/config"
	"github.com/liveagent/agent-gateway/internal/db"
	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/protocol/pbws"
	"github.com/liveagent/agent-gateway/internal/session"
)

const concurrentAgentConnections = 1000

type agentHandshakeResult struct {
	conn *websocket.Conn
	err  error
}

func benchmarkAgentHello(agentID, token string) ([]byte, error) {
	return proto.Marshal(&gatewayv2.AgentClientFrame{
		Payload: &gatewayv2.AgentClientFrame_Hello{
			Hello: &gatewayv2.ClientHello{
				ProtocolVersion: pbws.ProtocolVersion,
				Role:            gatewayv2.ClientRole_CLIENT_ROLE_AGENT,
				AgentId:         agentID,
				Token:           token,
				AgentVersion:    "benchmark",
			},
		},
	})
}

func dialAndAuthenticateBenchmarkAgent(
	wsURL, origin string,
	helloFrame []byte,
) (*websocket.Conn, error) {
	dialer := websocket.Dialer{Subprotocols: []string{pbws.Subprotocol}}
	conn, response, err := dialer.Dial(wsURL, http.Header{"Origin": []string{origin}})
	if err != nil {
		if response != nil && response.Body != nil {
			_ = response.Body.Close()
		}
		return nil, fmt.Errorf("dial websocket: %w", err)
	}
	deadline := time.Now().Add(15 * time.Second)
	if err := conn.SetWriteDeadline(deadline); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("set write deadline: %w", err)
	}
	if err := conn.WriteMessage(websocket.BinaryMessage, helloFrame); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("write hello: %w", err)
	}
	if err := conn.SetReadDeadline(deadline); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("set read deadline: %w", err)
	}
	messageType, payload, err := conn.ReadMessage()
	if err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("read hello: %w", err)
	}
	if messageType != websocket.BinaryMessage {
		_ = conn.Close()
		return nil, fmt.Errorf("hello message type = %d, want binary", messageType)
	}
	var frame gatewayv2.AgentServerFrame
	if err := proto.Unmarshal(payload, &frame); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("unmarshal hello: %w", err)
	}
	if hello := frame.GetHello(); hello == nil || !hello.GetOk() {
		_ = conn.Close()
		return nil, fmt.Errorf("gateway rejected hello: %v", frame.GetHello())
	}
	return conn, nil
}

// Benchmark1000AgentWebSocketHandshakes 测量 1000 个已签发独立凭证的 Agent
// 同时完成 HTTP Upgrade、WebSocket+Protobuf hello、SQLite 鉴权和会话登记的整批耗时。
// Worker 创建、凭证签发和测试服务器初始化不计入计时。
func Benchmark1000AgentWebSocketHandshakes(b *testing.B) {
	tempDir := b.TempDir()
	b.ReportAllocs()
	b.ResetTimer()

	for iteration := range b.N {
		b.StopTimer()
		database, err := db.Open(filepath.Join(tempDir, fmt.Sprintf("gateway-%d.db", iteration)))
		if err != nil {
			b.Fatalf("open benchmark database: %v", err)
		}
		store, err := agenttoken.NewStore(database)
		if err != nil {
			_ = database.Close()
			b.Fatalf("open agent token store: %v", err)
		}

		helloFrames := make([][]byte, concurrentAgentConnections)
		for index := range helloFrames {
			agentID := fmt.Sprintf("agent-00000000-0000-4000-8000-%012x", index)
			token, issueErr := store.Issue(agentID, "")
			if issueErr != nil {
				_ = database.Close()
				b.Fatalf("issue token %d: %v", index, issueErr)
			}
			helloFrames[index], err = benchmarkAgentHello(agentID, token)
			if err != nil {
				_ = database.Close()
				b.Fatalf("marshal hello %d: %v", index, err)
			}
		}

		cfg := &config.Config{
			Token:                    "benchmark-gateway-token",
			MaxAgentConnections:      concurrentAgentConnections + 100,
			RequestTimeout:           15 * time.Second,
			HeartbeatPeriod:          time.Hour,
			WebSocketHeartbeatPeriod: time.Hour,
			WebSocketWriteTimeout:    15 * time.Second,
		}
		manager := session.NewManager()
		server := pbws.NewServer(cfg, manager, store)
		mux := http.NewServeMux()
		mux.Handle("/ws/v2/agent", server.AgentHandler())
		testServer := httptest.NewServer(mux)
		wsURL := "ws" + strings.TrimPrefix(testServer.URL, "http") + "/ws/v2/agent"

		results := make([]agentHandshakeResult, len(helloFrames))
		start := make(chan struct{})
		var ready sync.WaitGroup
		var done sync.WaitGroup
		ready.Add(len(helloFrames))
		done.Add(len(helloFrames))
		for index := range helloFrames {
			go func() {
				defer done.Done()
				ready.Done()
				<-start
				results[index].conn, results[index].err = dialAndAuthenticateBenchmarkAgent(
					wsURL, testServer.URL, helloFrames[index],
				)
			}()
		}
		ready.Wait()
		b.StartTimer()
		close(start)
		done.Wait()
		b.StopTimer()

		for index := range results {
			if results[index].err != nil {
				for cleanupIndex := range results {
					if results[cleanupIndex].conn != nil {
						_ = results[cleanupIndex].conn.Close()
					}
				}
				testServer.Close()
				_ = database.Close()
				b.Fatalf("agent handshake %d: %v", index, results[index].err)
			}
		}
		if online := manager.ConnectedAgentIDs(); len(online) != concurrentAgentConnections {
			b.Fatalf("online agents = %d, want %d", len(online), concurrentAgentConnections)
		}
		for index := range results {
			_ = results[index].conn.Close()
		}
		testServer.Close()
		if err := database.Close(); err != nil {
			b.Fatalf("close benchmark database: %v", err)
		}
	}

	elapsed := b.Elapsed()
	b.ReportMetric(
		float64(b.N*concurrentAgentConnections)/elapsed.Seconds(),
		"connections/s",
	)
	b.ReportMetric(
		float64(elapsed.Nanoseconds())/float64(b.N*concurrentAgentConnections),
		"ns/connection",
	)
}
