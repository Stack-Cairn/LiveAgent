package stt

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/liveagent/agent-gateway/internal/db"
	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/protocol/pbws"
	"google.golang.org/protobuf/proto"
)

type fixtureAdapter struct{ consume bool }

type errorAdapter struct{}

type probeAdapter struct {
	commands chan Command
}

func (errorAdapter) Test(context.Context, map[string]any) (string, error) {
	return "protocol_failed", errors.New("provider fixture-secret")
}
func (errorAdapter) Run(context.Context, string, map[string]any, <-chan Command, chan<- Event) error {
	return errors.New("provider fixture-secret")
}

func (a probeAdapter) Test(context.Context, map[string]any) (string, error) {
	return "connected", nil
}

func (a probeAdapter) Run(ctx context.Context, id string, _ map[string]any, commands <-chan Command, events chan<- Event) error {
	events <- Event{Type: "ready", SessionID: id}
	for {
		select {
		case <-ctx.Done():
			return nil
		case command := <-commands:
			a.commands <- command
			if command.Cancel || command.Finish {
				return nil
			}
		}
	}
}

func (a fixtureAdapter) Test(context.Context, map[string]any) (string, error) {
	return "connected_no_speech", nil
}
func (a fixtureAdapter) Run(ctx context.Context, id string, cfg map[string]any, commands <-chan Command, events chan<- Event) error {
	events <- Event{Type: "ready", SessionID: id}
	if !a.consume {
		<-ctx.Done()
		return ctx.Err()
	}
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case command := <-commands:
			if command.Audio != nil {
				events <- Event{Type: "partial", SessionID: id, Text: "fixture"}
			}
			if command.Finish {
				events <- Event{Type: "final", SessionID: id, Text: "fixture final"}
				return nil
			}
		}
	}
}

func fixtureStore(t *testing.T) *Store {
	t.Helper()
	database, err := db.Open(t.TempDir() + "/stt.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	store, err := NewStore(database)
	if err != nil {
		t.Fatal(err)
	}
	settings := defaults()
	settings.Providers["aliyun_dashscope"]["apiKey"] = "fixture-secret"
	if _, err := store.Update(context.Background(), settings); err != nil {
		t.Fatal(err)
	}
	return store
}

func TestSyncFromDesktopClearsStaleGatewaySecrets(t *testing.T) {
	store := fixtureStore(t)
	settings := defaults()
	provider := "aliyun_dashscope"
	settings.Provider = &provider
	settings.Providers[provider]["apiKey"] = ""
	if _, err := store.SyncFromDesktop(context.Background(), settings); err != nil {
		t.Fatal(err)
	}
	redacted, err := store.Get(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if redacted.Providers[provider]["configured"] != false {
		t.Fatalf("expected cleared provider to be unconfigured: %#v", redacted.Providers[provider])
	}
	if _, err := store.Provider(context.Background(), provider); err == nil {
		t.Fatal("cleared desktop secret remained usable in Gateway runtime")
	}
}

func withFixtureAdapter(t *testing.T, adapter Adapter) {
	t.Helper()
	previous := adapterFactory
	adapterFactory = func(string) Adapter { return adapter }
	t.Cleanup(func() { adapterFactory = previous })
}

func TestConnectionProbeUsesCompleteSilentAudioProtocol(t *testing.T) {
	commands := make(chan Command, 16)
	result, err := silentProtocolTest(context.Background(), probeAdapter{commands: commands}, map[string]any{})
	if err != nil || result != "connected_no_speech" {
		t.Fatalf("silent protocol probe failed: result=%q err=%v", result, err)
	}
	for sequence := uint32(0); sequence < 10; sequence++ {
		command := <-commands
		if command.Audio == nil || command.Audio.Sequence != sequence || len(command.Audio.PCM) != 3200 {
			t.Fatalf("unexpected silent probe packet %d: %#v", sequence, command)
		}
	}
	if command := <-commands; !command.Finish || command.Audio != nil || command.Cancel {
		t.Fatalf("silent probe must finish after ten packets: %#v", command)
	}
}

func TestReadyConnectionProbeStopsAfterProviderReady(t *testing.T) {
	commands := make(chan Command, 1)
	result, err := readyProtocolTest(context.Background(), probeAdapter{commands: commands}, map[string]any{})
	if err != nil || result != "connected" {
		t.Fatalf("ready protocol probe failed: result=%q err=%v", result, err)
	}
	select {
	case command := <-commands:
		if !command.Cancel || command.Audio != nil || command.Finish {
			t.Fatalf("ready probe must cancel without sending synthetic audio: %#v", command)
		}
	case <-time.After(time.Second):
		t.Fatal("ready probe did not cancel the provider session")
	}
}

func TestManagerRejectsDuplicateUnknownAndMissingSessions(t *testing.T) {
	manager := NewManager(fixtureStore(t))
	withFixtureAdapter(t, fixtureAdapter{consume: false})
	events := make(chan Event, 256)
	if err := manager.Start(context.Background(), "session", "aliyun_dashscope", events); err != nil {
		t.Fatal(err)
	}
	if err := manager.Start(context.Background(), "session", "aliyun_dashscope", events); err == nil {
		t.Fatal("duplicate session id must be rejected")
	}
	if err := manager.Start(context.Background(), "other", "unknown", events); err == nil {
		t.Fatal("unknown provider must be rejected")
	}
	if err := manager.Send("missing", Command{}); err == nil {
		t.Fatal("unknown session must be rejected")
	}
	for index := 0; index < 128; index++ {
		if err := manager.Send("session", Command{Audio: &AudioChunk{Sequence: uint32(index), PCM: []byte{0, 0}}}); err != nil {
			t.Fatalf("queue fill failed at %d: %v", index, err)
		}
	}
	if err := manager.Send("session", Command{Audio: &AudioChunk{Sequence: 128, PCM: []byte{0, 0}}}); err == nil {
		t.Fatal("full write queue must be rejected")
	}
	manager.Cancel("session")
}

func TestManagerCancelsAdapterAndRedactsProviderErrors(t *testing.T) {
	manager := NewManager(fixtureStore(t))
	withFixtureAdapter(t, errorAdapter{})
	events := make(chan Event, 256)
	if err := manager.Start(context.Background(), "session", "aliyun_dashscope", events); err != nil {
		t.Fatal(err)
	}
	deadline := time.After(time.Second)
	seenError := false
	for {
		select {
		case event := <-events:
			if event.Type == "error" {
				seenError = true
				if strings.Contains(event.Message, "fixture-secret") {
					t.Fatalf("provider secret leaked in event: %q", event.Message)
				}
			}
			if event.Type == "closed" {
				if !seenError {
					t.Fatal("provider error event was not emitted")
				}
				return
			}
		case <-deadline:
			t.Fatal("cancel did not close adapter")
		}
	}
}

func TestSttServerEventMappingAndWebSocketSequenceValidation(t *testing.T) {
	manager := NewManager(fixtureStore(t))
	withFixtureAdapter(t, fixtureAdapter{consume: true})
	// Exercise every server-event oneof directly so a regression cannot silently
	// collapse final/error/closed into the same frame shape.
	eventServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		for _, event := range []Event{
			{Type: "ready", SessionID: "s"},
			{Type: "partial", SessionID: "s", Text: "p"},
			{Type: "final", SessionID: "s", Text: "f"},
			{Type: "error", SessionID: "s", Code: "bad", Message: "safe"},
			{Type: "closed", SessionID: "s"},
		} {
			if !writeSttEvent(conn, event) {
				return
			}
		}
	}))
	t.Cleanup(eventServer.Close)
	eventURL := "ws" + strings.TrimPrefix(eventServer.URL, "http")
	eventConn, _, err := websocket.DefaultDialer.Dial(eventURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []func(*gatewayv2.SttServerFrame) bool{
		func(frame *gatewayv2.SttServerFrame) bool { return frame.GetReady().GetSessionId() == "s" },
		func(frame *gatewayv2.SttServerFrame) bool { return frame.GetPartial().GetText() == "p" },
		func(frame *gatewayv2.SttServerFrame) bool { return frame.GetFinal().GetText() == "f" },
		func(frame *gatewayv2.SttServerFrame) bool {
			return frame.GetError().GetCode() == "bad" && frame.GetError().GetMessage() == "safe"
		},
		func(frame *gatewayv2.SttServerFrame) bool { return frame.GetClosed().GetSessionId() == "s" },
	} {
		kind, data, readErr := eventConn.ReadMessage()
		if readErr != nil || kind != websocket.BinaryMessage {
			t.Fatalf("event frame read failed: kind=%d err=%v", kind, readErr)
		}
		var frame gatewayv2.SttServerFrame
		if err := proto.Unmarshal(data, &frame); err != nil || !want(&frame) {
			t.Fatalf("unexpected event frame: %v %#v", err, frame.GetPayload())
		}
	}
	_ = eventConn.Close()

	server := httptest.NewServer(manager.WebSocketHandler("token"))
	t.Cleanup(server.Close)
	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	hello := &gatewayv2.SttClientFrame{Payload: &gatewayv2.SttClientFrame_Hello{Hello: &gatewayv2.SttClientHello{ProtocolVersion: pbws.ProtocolVersion, Token: "token"}}}
	if err := conn.WriteMessage(websocket.BinaryMessage, mustProto(hello)); err != nil {
		t.Fatal(err)
	}
	if _, _, err := conn.ReadMessage(); err != nil {
		t.Fatal("hello response: ", err)
	}
	if err := conn.WriteMessage(websocket.BinaryMessage, mustProto(&gatewayv2.SttClientFrame{Payload: &gatewayv2.SttClientFrame_Start{Start: &gatewayv2.SttStart{SessionId: "s", Provider: "aliyun_dashscope"}}})); err != nil {
		t.Fatal(err)
	}
	if _, _, err := conn.ReadMessage(); err != nil {
		t.Fatal("ready response: ", err)
	}
	audio := func(sequence uint32) []byte {
		return mustProto(&gatewayv2.SttClientFrame{Payload: &gatewayv2.SttClientFrame_Audio{Audio: &gatewayv2.SttAudio{SessionId: "s", Sequence: sequence, Pcm: []byte{0, 0}}}})
	}
	if err := conn.WriteMessage(websocket.BinaryMessage, audio(0)); err != nil {
		t.Fatal(err)
	}
	if _, _, err := conn.ReadMessage(); err != nil {
		t.Fatal("partial response: ", err)
	}
	if err := conn.WriteMessage(websocket.BinaryMessage, audio(0)); err != nil {
		t.Fatal(err)
	}
	conn.SetReadDeadline(time.Now().Add(time.Second))
	if _, _, err := conn.ReadMessage(); err == nil {
		t.Fatal("duplicate sequence must close the connection")
	}
}

func mustProto(message proto.Message) []byte {
	data, err := proto.Marshal(message)
	if err != nil {
		panic(err)
	}
	return data
}

func TestVolcV2FrameRoundTrip(t *testing.T) {
	payload, err := gzipJSON(map[string]any{"code": float64(1000), "message": "Success"})
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := decodeVolcV2Frame(volcV2Frame(1, 0, 1, 1, payload))
	if err != nil {
		t.Fatal(err)
	}
	if !volcV2ResponseOK(decoded) {
		t.Fatalf("code 1000/Success should be accepted: %#v", decoded)
	}
	if _, err := decodeVolcV2Frame([]byte{0x11}); err == nil {
		t.Fatal("short frame should fail")
	}
	end := volcV2Frame(2, 2, 0, 0, nil)
	if end[1] != 0x22 || len(end) != 8 {
		t.Fatalf("unexpected v2 end frame: %#v", end)
	}
}

func TestVolcV2AndSeedV3EndpointsRemainDistinct(t *testing.T) {
	if strings.Contains("wss://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash", "/api/v2/asr") {
		t.Fatal("v3 endpoint must not be v2 endpoint")
	}
}

func TestTencentSignedURL(t *testing.T) {
	signed := tencentSignedURL("123", "16k_zh", "sid", "secret", "voice", 1700000000)
	u, err := url.Parse(signed)
	if err != nil {
		t.Fatal(err)
	}
	if u.Path != "/asr/v2/123" {
		t.Fatalf("unexpected path: %s", u.Path)
	}
	q := u.Query()
	for _, field := range []string{"convert_num_mode", "engine_model_type", "expired", "filter_dirty", "filter_modal", "filter_punc", "needvad", "nonce", "secretid", "timestamp", "voice_format", "voice_id", "word_info", "signature"} {
		if q.Get(field) == "" {
			t.Fatalf("missing %s", field)
		}
	}
	if len(q.Get("signature")) < 20 {
		t.Fatal("signature is not HMAC-SHA1 base64")
	}
	if strings.Contains(signed, "wss://asr.cloud.tencent.com/asr/v2/123?wss://") {
		t.Fatal("signature query must not be duplicated")
	}
	if nonce, err := strconv.ParseUint(q.Get("nonce"), 10, 32); err != nil || nonce == 0 {
		t.Fatalf("Tencent nonce must be a non-zero decimal integer: %q", q.Get("nonce"))
	}
}

func TestProviderProtocolFixtures(t *testing.T) {
	if got := dashScopeModel(""); got != "paraformer-realtime-v2" {
		t.Fatalf("DashScope default model must accept 16 kHz PCM: %q", got)
	}
	if got := dashScopeModel("paraformer-realtime-8k-v2"); got != "paraformer-realtime-v2" {
		t.Fatalf("legacy incorrect DashScope model was not migrated: %q", got)
	}
	if dashScopeFinish("fixture-task")["payload"] == nil {
		t.Fatal("DashScope finish-task must include payload.input")
	}
	if got := mergeTencentFragments(map[int]string{4: "后", 1: "前", 2: "中"}); got != "前中后" {
		t.Fatalf("乱序片段未按 index 合并: %q", got)
	}
	if !baiduNoSpeech(3301) || !baiduNoSpeech(-3005) || baiduNoSpeech(3300) {
		t.Fatal("百度无语音错误码分类错误")
	}
	if got := volcV2Authorization("token"); got != "Bearer; token" {
		t.Fatalf("火山 v2 authorization 格式错误: %q", got)
	}
	if volcengineV2Endpoint == volcengineSeedV3Endpoint {
		t.Fatal("火山 v2/v3 endpoint must remain isolated")
	}
	if !tencentMessageComplete(map[string]any{"final": float64(1)}) || tencentMessageComplete(map[string]any{"final": float64(0)}) {
		t.Fatal("腾讯结束响应必须按 final=1 判定")
	}
	index, transcript, ok := tencentResult(map[string]any{"index": float64(99), "result": map[string]any{"index": float64(7), "voice_text_str": "嵌套结果"}})
	if !ok || index != 7 || transcript != "嵌套结果" {
		t.Fatalf("Tencent result index must come from result.index: %d %q %v", index, transcript, ok)
	}
}

func TestProviderFailureKeepsNoSpeechOutOfProtocolErrors(t *testing.T) {
	err := providerFailure("Volcengine v2", "1013", "No valid speeches found in input audio")
	if result := resultForError(err); result != "connected_no_speech" {
		t.Fatalf("resultForError() = %q, want connected_no_speech", result)
	}

	wrapped := stageError("VolcengineV2", "provider_response", err)
	if result := resultForError(wrapped); result != "connected_no_speech" {
		t.Fatalf("wrapped resultForError() = %q, want connected_no_speech", result)
	}
	if !strings.Contains(wrapped.Error(), "[VolcengineV2/provider_response]") {
		t.Fatalf("stage context missing from %q", wrapped.Error())
	}

	if !volcV2ResponseNoSpeech(map[string]any{"code": float64(1013)}) {
		t.Fatal("火山 v2 code 1013 must be classified as no speech")
	}
	if volcV2ResponseNoSpeech(map[string]any{"code": float64(45000000)}) {
		t.Fatal("火山 v2 non-1013 errors must remain protocol failures")
	}
}

func TestStageErrorPreservesWebSocketCloseCodes(t *testing.T) {
	closed := stageError("DashScope", "receive", &websocket.CloseError{Code: websocket.CloseNormalClosure})
	if !isWebSocketCloseError(closed, websocket.CloseNormalClosure) {
		t.Fatal("stage error must preserve a normal WebSocket close code")
	}
	if isWebSocketCloseError(closed, websocket.CloseProtocolError) {
		t.Fatal("normal closure must not match a protocol close code")
	}
}

func TestVolcengineV2RequiresExplicitLastResponseToComplete(t *testing.T) {
	textOnly := map[string]any{"result": map[string]any{"text": "partial"}}
	if volcV2ResponseComplete(textOnly, true) {
		t.Fatal("text without a last marker must not complete the v2 session")
	}
	if !volcV2ResponseComplete(map[string]any{"_last": true}, true) {
		t.Fatal("negative-sequence response must complete a finishing v2 session")
	}
	if volcV2ResponseComplete(map[string]any{"_last": true}, false) {
		t.Fatal("last response must not complete before the client starts finishing")
	}
}

func TestProviderFieldDefaultsMatchRuntimeProtocols(t *testing.T) {
	settings := defaults()
	aliyun := settings.Providers["aliyun_dashscope"]
	if aliyun["websocketUrl"] != dashScopeEndpoint || aliyun["model"] != "paraformer-realtime-v2" {
		t.Fatalf("unexpected DashScope defaults: %#v", aliyun)
	}
	v2 := settings.Providers["volcengine_v2"]
	if v2["websocketUrl"] != volcengineV2Endpoint || v2["cluster"] != "" {
		t.Fatalf("unexpected Volcengine v2 defaults: %#v", v2)
	}
	if settings.Providers["volcengine_seed_v3"]["websocketUrl"] != volcengineSeedV3Endpoint {
		t.Fatal("Seed v3 WebSocket default does not match the adapter")
	}
	if settings.Providers["baidu_cloud"]["websocketUrl"] != baiduRealtimeEndpoint {
		t.Fatal("Baidu WebSocket default does not match the adapter")
	}
}

func TestVolcengineAudioAndSequenceFrames(t *testing.T) {
	start := volcV2StartRequest(map[string]any{"appId": "app", "accessToken": "token", "cluster": "cluster"}, "session", "request")
	app, _ := start["app"].(map[string]any)
	audioRequest, _ := start["audio"].(map[string]any)
	request, _ := start["request"].(map[string]any)
	if app["token"] != "token" || audioRequest["format"] != "raw" || audioRequest["codec"] != "raw" || request["workflow"] == "" || request["show_utterances"] != true || request["result_type"] != "full" {
		t.Fatalf("Volcengine v2 full request is incomplete: %#v", start)
	}
	compressed, err := gzipBytes([]byte{0, 1, 2, 3})
	if err != nil {
		t.Fatal(err)
	}
	audio := volcV2Frame(2, 0, 0, 1, compressed)
	if audio[1]>>4 != 2 || audio[2]&0x0f != 1 {
		t.Fatalf("v2 audio frame must be audio-only gzip: %x", audio[:4])
	}
	payload, err := gzipJSON(map[string]any{"code": 1000, "message": "Success"})
	if err != nil {
		t.Fatal(err)
	}
	header := []byte{0x11, 0x91, 0x11, 0}
	sequence := make([]byte, 4)
	binary.BigEndian.PutUint32(sequence, 7)
	size := make([]byte, 4)
	binary.BigEndian.PutUint32(size, uint32(len(payload)))
	response := append(append(append(header, sequence...), size...), payload...)
	decoded, err := decodeVolcV2Frame(response)
	if err != nil || !volcV2ResponseOK(decoded) {
		t.Fatalf("v2 sequence response was not decoded: %#v %v", decoded, err)
	}
	negativeSequence := make([]byte, 4)
	binary.BigEndian.PutUint32(negativeSequence, uint32(0xffffffff))
	lastResponse := append(append(append(header, negativeSequence...), size...), payload...)
	lastDecoded, err := decodeVolcV2Frame(lastResponse)
	if err != nil || lastDecoded["_last"] != true {
		t.Fatalf("v2 negative sequence must mark the final response: %#v %v", lastDecoded, err)
	}
	if got := volcV2ResultText(map[string]any{"result": []any{map[string]any{"text": "fixture"}}}); got != "fixture" {
		t.Fatalf("v2 array result text was not decoded: %q", got)
	}
}

func TestVolcengineSeedV3RequestAndFrames(t *testing.T) {
	if volcengineSeedV3Endpoint != "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async" {
		t.Fatalf("Seed v3 must use the streaming async endpoint, got %q", volcengineSeedV3Endpoint)
	}
	headers := seedV3Headers(map[string]any{
		"appId": "app-id", "accessToken": "access-token", "resourceId": "resource-id",
	}, "connect-id")
	if headers.Get("X-Api-App-Key") != "app-id" ||
		headers.Get("X-Api-Access-Key") != "access-token" ||
		headers.Get("X-Api-Resource-Id") != "resource-id" ||
		headers.Get("X-Api-Connect-Id") != "connect-id" {
		t.Fatalf("Seed v3 connection headers are incomplete: %#v", headers)
	}
	if headers.Get("X-Api-Request-Id") != "" {
		t.Fatal("Seed v3 must use X-Api-Connect-Id, not X-Api-Request-Id")
	}
	request := seedV3StartRequest("fixture-session")
	audio, ok := request["audio"].(map[string]any)
	if !ok || audio["format"] != "pcm" || audio["codec"] != "raw" || audio["rate"] != 16000 {
		t.Fatalf("unexpected Seed v3 audio request: %#v", request["audio"])
	}
	options, ok := request["request"].(map[string]any)
	if !ok || options["model_name"] != "bigmodel" {
		t.Fatalf("Seed v3 model_name is required: %#v", request["request"])
	}
	if options["show_utterances"] != true || options["result_type"] != "full" {
		t.Fatal("Seed v3 must request full utterance results")
	}
	compressed, err := gzipBytes([]byte{0, 1, 2, 3})
	if err != nil {
		t.Fatal(err)
	}
	audioFrame := seedV3AudioFrame(false, compressed)
	if audioFrame[1] != 0x20 || audioFrame[2] != 0x01 || int(binary.BigEndian.Uint32(audioFrame[4:8])) != len(compressed) || len(audioFrame) != 8+len(compressed) {
		t.Fatalf("Seed v3 audio frame must omit the client sequence: %x", audioFrame[:8])
	}
	lastFrame := seedV3AudioFrame(true, compressed)
	if lastFrame[1] != 0x22 || lastFrame[2] != 0x01 || int(binary.BigEndian.Uint32(lastFrame[4:8])) != len(compressed) || len(lastFrame) != 8+len(compressed) {
		t.Fatalf("Seed v3 final frame must use the last-audio flag without a client sequence: %x", lastFrame[:8])
	}
}

func TestResultClassification(t *testing.T) {
	if got := resultForError(&ResultError{Result: "authentication_failed", Err: context.Canceled}); got != "authentication_failed" {
		t.Fatal(got)
	}
	if got := resultForError(&net.DNSError{IsTimeout: true}); got != "network_failed" {
		t.Fatal(got)
	}
	if got := resultForError(context.DeadlineExceeded); got != "timeout" {
		t.Fatal(got)
	}
	for status, expected := range map[int]string{
		http.StatusUnauthorized:        "authentication_failed",
		http.StatusForbidden:           "authentication_failed",
		http.StatusBadRequest:          "protocol_failed",
		http.StatusInternalServerError: "network_failed",
		http.StatusServiceUnavailable:  "network_failed",
	} {
		response := &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader("must not be exposed"))}
		classified := websocketConnectError(response, errors.New("websocket: bad handshake"))
		if got := resultForError(classified); got != expected {
			t.Fatalf("HTTP %d classified as %q, want %q", status, got, expected)
		}
		if strings.Contains(classified.Error(), "must not be exposed") {
			t.Fatal("handshake response body must not be included in diagnostics")
		}
	}
	diagnostic := sanitizeError(
		"request wss://example.invalid/asr?secretid=fixture-id&signature=fixture-signature failed with fixture-key",
		map[string]any{"secretKey": "fixture-key"},
	)
	if diagnostic != "request [provider endpoint] failed with [redacted]" {
		t.Fatalf("provider diagnostic was not safely redacted: %q", diagnostic)
	}
}

func TestSettingsRedactPreserveAndClearSecrets(t *testing.T) {
	database, err := db.Open(t.TempDir() + "/stt.db")
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	store, err := NewStore(database)
	if err != nil {
		t.Fatal(err)
	}
	incoming := defaults()
	incoming.Providers["aliyun_dashscope"]["apiKey"] = "secret-value"
	if _, err := store.Update(context.Background(), incoming); err != nil {
		t.Fatal(err)
	}
	redacted, err := store.Get(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if redacted.Providers["aliyun_dashscope"]["apiKey"] != "" || !redacted.Providers["aliyun_dashscope"]["configured"].(bool) {
		t.Fatalf("secret leaked or provider not configured: %#v", redacted.Providers["aliyun_dashscope"])
	}
	keep := defaults()
	keep.Providers["aliyun_dashscope"] = map[string]any{"apiKey": "", "id": "aliyun_dashscope"}
	if _, err := store.Update(context.Background(), keep); err != nil {
		t.Fatal(err)
	}
	raw, err := store.Provider(context.Background(), "aliyun_dashscope")
	if err != nil || raw["apiKey"] != "secret-value" {
		t.Fatalf("blank update should preserve secret: %#v %v", raw, err)
	}
	clear := defaults()
	clear.Providers["aliyun_dashscope"] = map[string]any{"apiKey": "", "clearSecrets": true, "id": "aliyun_dashscope"}
	if _, err := store.Update(context.Background(), clear); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Provider(context.Background(), "aliyun_dashscope"); err == nil {
		t.Fatal("cleared provider should be unavailable")
	}
}

func TestBaiduConfiguredRequiresNumericIDs(t *testing.T) {
	p := map[string]any{
		"websocketUrl": baiduRealtimeEndpoint,
		"baiduAppId":   "abc",
		"baiduApiKey":  "key",
		"devPid":       "1537",
	}
	if configured("baidu_cloud", p) {
		t.Fatal("non-numeric appid must not configure provider")
	}
	p["baiduAppId"] = "123"
	if !configured("baidu_cloud", p) {
		t.Fatal("numeric appid and dev_pid should configure provider")
	}
	p["devPid"] = "0"
	if configured("baidu_cloud", p) {
		t.Fatal("zero dev_pid must not configure provider")
	}
}

func TestSettingsUpdateValidatesSelectedProviderOnly(t *testing.T) {
	store := fixtureStore(t)
	invalid := defaults()
	provider := "tencent_cloud"
	invalid.Provider = &provider
	invalid.Providers[provider]["appId"] = "not-numeric"
	invalid.Providers[provider]["engineModelType"] = "16k_zh"
	invalid.Providers[provider]["secretId"] = "id"
	invalid.Providers[provider]["secretKey"] = "key"
	if _, err := store.Update(context.Background(), invalid); err == nil || !strings.Contains(err.Error(), "positive decimal integer") {
		t.Fatalf("invalid Tencent AppId must be rejected before persistence: %v", err)
	}

	clear := defaults()
	clear.Provider = &provider
	clear.Providers[provider]["clearSecrets"] = true
	if _, err := store.Update(context.Background(), clear); err != nil {
		t.Fatalf("explicit secret clearing must remain valid: %v", err)
	}
}

func TestBaiduStartUsesNumericIDsAndNestedData(t *testing.T) {
	message := baiduStartMessage(123, 1537, "app-key", "session")
	data, ok := message["data"].(map[string]any)
	if !ok {
		t.Fatal("START data must be an object")
	}
	if _, ok := data["appid"].(uint64); !ok {
		t.Fatalf("appid must be JSON number, got %T", data["appid"])
	}
	if _, ok := data["dev_pid"].(uint32); !ok {
		t.Fatalf("dev_pid must be numeric, got %T", data["dev_pid"])
	}
	if _, ok := message["appid"]; ok {
		t.Fatal("appid must be nested under START data")
	}
}

func TestBaiduAcceptsNoStatusCloseAfterFinish(t *testing.T) {
	err := &websocket.CloseError{Code: websocket.CloseNoStatusReceived, Text: "no status"}
	if !baiduFinishedConnectionClosed(err) {
		t.Fatal("Baidu FINISH must accept a provider close without a status frame")
	}
	if baiduFinishedConnectionClosed(&websocket.CloseError{Code: websocket.CloseProtocolError, Text: "bad frame"}) {
		t.Fatal("Baidu must not hide a real protocol close")
	}
}

func TestBaiduEndpointAndResultFixtures(t *testing.T) {
	endpoint, err := baiduEndpoint(baiduRealtimeEndpoint)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Query().Get("sn") == "" {
		t.Fatalf("Baidu WebSocket URL must include a unique sn: %q %v", endpoint, err)
	}
	if text := baiduResultText([]any{"你好，", "世界。"}); text != "你好，世界。" {
		t.Fatalf("Baidu array result was not joined: %q", text)
	}
	if text := baiduResultText(" 单句 "); text != "单句" {
		t.Fatalf("Baidu string result was not normalized: %q", text)
	}
}

func TestSeedV3FrameRoundTrip(t *testing.T) {
	payload, err := seedV3JSON(map[string]any{"is_last_package": true, "result": map[string]any{"text": "ok"}})
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := decodeSeedV3Frame(seedV3Frame(9, 0, 1, payload))
	if err != nil {
		t.Fatal(err)
	}
	if decoded["is_last_package"] != true {
		t.Fatalf("unexpected Seed v3 response: %#v", decoded)
	}
}

func TestGzipPayloadIsJSON(t *testing.T) {
	payload, err := gzipJSON(map[string]string{"x": "y"})
	if err != nil {
		t.Fatal(err)
	}
	reader, err := gzip.NewReader(bytes.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	data, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	var value map[string]string
	if json.Unmarshal(data, &value) != nil || value["x"] != "y" {
		t.Fatalf("invalid gzip JSON: %s", data)
	}
}

func TestSttProtobufAudioRoundTrip(t *testing.T) {
	want := &gatewayv2.SttClientFrame{Payload: &gatewayv2.SttClientFrame_Audio{Audio: &gatewayv2.SttAudio{SessionId: "session", Sequence: 7, Pcm: []byte{0, 1, 2, 3}}}}
	data, err := proto.Marshal(want)
	if err != nil {
		t.Fatal(err)
	}
	var got gatewayv2.SttClientFrame
	if err := proto.Unmarshal(data, &got); err != nil {
		t.Fatal(err)
	}
	if got.GetAudio().GetSessionId() != "session" || got.GetAudio().GetSequence() != 7 || !bytes.Equal(got.GetAudio().GetPcm(), []byte{0, 1, 2, 3}) {
		t.Fatalf("unexpected STT frame: %#v", got.GetAudio())
	}
}
