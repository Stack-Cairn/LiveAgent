package stt

import (
	"context"
	"errors"
	"io"
	"net/url"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

type BaiduCloudAdapter struct{}

const baiduRealtimeEndpoint = "wss://vop.baidu.com/realtime_asr"

func baiduNoSpeech(errNo float64) bool { return errNo == 3301 || errNo == -3005 }

func baiduFinishedConnectionClosed(err error) bool {
	return errors.Is(err, io.EOF) || isWebSocketCloseError(
		err,
		websocket.CloseNormalClosure,
		websocket.CloseGoingAway,
		websocket.CloseNoStatusReceived,
	)
}

func baiduStartMessage(appid uint64, devPID uint32, appKey, cuid string) map[string]any {
	return map[string]any{
		"type": "START",
		"data": map[string]any{
			"appid": appid, "appkey": appKey, "dev_pid": devPID,
			"cuid": cuid, "format": "pcm", "sample": 16000,
		},
	}
}

func baiduEndpoint(configured string) (string, error) {
	endpoint, err := websocketEndpoint(map[string]any{"websocketUrl": configured}, baiduRealtimeEndpoint)
	if err != nil {
		return "", err
	}
	parsed, err := url.Parse(endpoint)
	if err != nil {
		return "", err
	}
	query := parsed.Query()
	query.Set("sn", uuid.NewString())
	parsed.RawQuery = query.Encode()
	return parsed.String(), nil
}

func baiduResultText(result any) string {
	switch typed := result.(type) {
	case string:
		return strings.TrimSpace(typed)
	case []any:
		var merged strings.Builder
		for _, item := range typed {
			if part, ok := item.(string); ok {
				merged.WriteString(part)
			}
		}
		return strings.TrimSpace(merged.String())
	default:
		return ""
	}
}

func (a *BaiduCloudAdapter) Test(ctx context.Context, cfg map[string]any) (string, error) {
	return silentProtocolTest(ctx, a, cfg)
}
func (a *BaiduCloudAdapter) Run(ctx context.Context, id string, cfg map[string]any, commands <-chan Command, events chan<- Event) error {
	endpoint, endpointErr := baiduEndpoint(value(cfg, "websocketUrl"))
	if endpointErr != nil {
		return stageError("Baidu", "validate", endpointErr)
	}
	appid, err := strconv.ParseUint(value(cfg, "baiduAppId"), 10, 64)
	if err != nil {
		return stageError("Baidu", "validate", &ResultError{Result: "authentication_failed", Err: errors.New("appid must be numeric")})
	}
	pid, err := strconv.ParseUint(value(cfg, "devPid"), 10, 32)
	if err != nil {
		return stageError("Baidu", "validate", &ResultError{Result: "protocol_failed", Err: errors.New("dev_pid is required")})
	}
	conn, response, err := websocket.DefaultDialer.DialContext(ctx, endpoint, nil)
	if err != nil {
		return stageError("Baidu", "connect", websocketConnectError(response, err))
	}
	defer func() { _ = conn.Close() }()
	if err = writeProviderJSON(conn, baiduStartMessage(appid, uint32(pid), value(cfg, "baiduApiKey"), "LiveAgent-"+uuid.NewString())); err != nil {
		return stageError("Baidu", "start", err)
	}
	if !emitEvent(ctx, events, Event{Type: "ready", SessionID: id}) {
		return ctx.Err()
	}
	incoming := make(chan map[string]any, 8)
	readErr := make(chan error, 1)
	go func() {
		for {
			var msg map[string]any
			if e := conn.ReadJSON(&msg); e != nil {
				readErr <- stageError("Baidu", "receive", e)
				return
			}
			if !emitIncoming(ctx, incoming, msg) {
				return
			}
		}
	}()
	finishSent := false
	noSpeechSeen := false
	finalText := ""
	for {
		select {
		case <-ctx.Done():
			return nil
		case e := <-readErr:
			if finishSent && baiduFinishedConnectionClosed(e) {
				if finalText != "" {
					if !emitEvent(ctx, events, Event{Type: "final", SessionID: id, Text: finalText}) {
						return ctx.Err()
					}
				}
				return nil
			}
			if finishSent {
				return stageError("Baidu", "close", e)
			}
			return e
		case cmd := <-commands:
			if cmd.Cancel {
				return nil
			}
			if cmd.Audio != nil {
				if e := writeProviderMessage(conn, websocket.BinaryMessage, cmd.Audio.PCM); e != nil {
					return stageError("Baidu", "send_audio", e)
				}
			}
			if cmd.Finish {
				finishSent = true
				if e := writeProviderJSON(conn, map[string]any{"type": "FINISH"}); e != nil {
					return stageError("Baidu", "finish", e)
				}
				if noSpeechSeen {
					return nil
				}
			}
		case msg := <-incoming:
			if n, ok := msg["err_no"].(float64); ok && n != 0 {
				if baiduNoSpeech(n) {
					noSpeechSeen = true
					if finishSent {
						return nil
					}
					continue
				}
				return stageError("Baidu", "provider_response", providerFailure("Baidu", strconv.Itoa(int(n)), valueString(msg, "err_msg")))
			}
			switch msg["type"] {
			case "MID_TEXT":
				textValue := baiduResultText(msg["result"])
				eventsEvent := Event{Type: "partial", SessionID: id, Text: finalText + textValue}
				if !emitEvent(ctx, events, eventsEvent) {
					return ctx.Err()
				}
			case "FIN_TEXT":
				textValue := baiduResultText(msg["result"])
				finalText += textValue
				if !emitEvent(ctx, events, Event{Type: "partial", SessionID: id, Text: finalText}) {
					return ctx.Err()
				}
				if finishSent {
					if finalText != "" {
						if !emitEvent(ctx, events, Event{Type: "final", SessionID: id, Text: finalText}) {
							return ctx.Err()
						}
					}
					return nil
				}
			case "FINISH":
				if finishSent {
					if finalText != "" {
						if !emitEvent(ctx, events, Event{Type: "final", SessionID: id, Text: finalText}) {
							return ctx.Err()
						}
					}
					return nil
				}
			}
		}
	}
}
