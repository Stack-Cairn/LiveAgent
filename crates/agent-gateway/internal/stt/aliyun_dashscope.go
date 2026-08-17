package stt

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/gorilla/websocket"
)

type AliyunDashScopeAdapter struct{}

const dashScopeEndpoint = "wss://dashscope.aliyuncs.com/api-ws/v1/inference/"

func dashScopeModel(configured string) string {
	model := strings.TrimSpace(configured)
	if model == "" || model == "paraformer-realtime-8k-v2" {
		return "paraformer-realtime-v2"
	}
	return model
}

func dashScopeFinish(taskID string) map[string]any {
	return map[string]any{
		"header":  map[string]any{"action": "finish-task", "task_id": taskID, "streaming": "duplex"},
		"payload": map[string]any{"input": map[string]any{}},
	}
}

func (a *AliyunDashScopeAdapter) Test(ctx context.Context, cfg map[string]any) (string, error) {
	return readyProtocolTest(ctx, a, cfg)
}
func (a *AliyunDashScopeAdapter) Run(ctx context.Context, id string, cfg map[string]any, commands <-chan Command, events chan<- Event) error {
	endpoint, err := websocketEndpoint(cfg, dashScopeEndpoint)
	if err != nil {
		return stageError("DashScope", "validate", err)
	}
	model := dashScopeModel(value(cfg, "model"))
	var taskBytes [16]byte
	if _, err := rand.Read(taskBytes[:]); err != nil {
		return stageError("DashScope", "start", err)
	}
	wireTaskID := fmt.Sprintf("%x", taskBytes)
	header := http.Header{}
	header.Set("Authorization", "Bearer "+value(cfg, "apiKey"))
	header.Set("X-DashScope-DataInspection", "enable")
	conn, response, err := websocket.DefaultDialer.DialContext(ctx, endpoint, header)
	if err != nil {
		return stageError("DashScope", "connect", websocketConnectError(response, err))
	}
	defer conn.Close()
	start := map[string]any{
		"header": map[string]any{"action": "run-task", "task_id": wireTaskID, "streaming": "duplex"},
		"payload": map[string]any{
			"task_group": "audio", "task": "asr", "function": "recognition",
			"model": model,
			"parameters": map[string]any{
				"format": "pcm", "sample_rate": 16000,
				"language_hints":             []string{"zh", "en"},
				"max_sentence_silence":       2000,
				"disfluency_removal_enabled": false,
			},
			"input": map[string]any{},
		},
	}
	if err = conn.WriteJSON(start); err != nil {
		return stageError("DashScope", "start", err)
	}
	incoming := make(chan map[string]any, 8)
	readErr := make(chan error, 1)
	go func() {
		for {
			var msg map[string]any
			if err := conn.ReadJSON(&msg); err != nil {
				readErr <- stageError("DashScope", "receive", err)
				return
			}
			incoming <- msg
		}
	}()
	finishing := false
	finishSent := false
	taskFinished := false
	ready := false
	pending := make([][]byte, 0, 32)
	finals := ""
	for {
		select {
		case <-ctx.Done():
			return nil
		case err := <-readErr:
			if taskFinished {
				return nil
			}
			if finishing && finishSent && isWebSocketCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
				return stageError("DashScope", "close", errors.New("connection closed before task-finished"))
			}
			return err
		case cmd := <-commands:
			if cmd.Cancel {
				return nil
			}
			if cmd.Audio != nil {
				if !ready {
					pending = append(pending, append([]byte(nil), cmd.Audio.PCM...))
				} else if err := conn.WriteMessage(websocket.BinaryMessage, cmd.Audio.PCM); err != nil {
					return stageError("DashScope", "send_audio", err)
				}
			}
			if cmd.Finish {
				finishing = true
				if ready && !finishSent {
					if err := conn.WriteJSON(dashScopeFinish(wireTaskID)); err != nil {
						return stageError("DashScope", "finish", err)
					}
					finishSent = true
				}
			}
		case msg := <-incoming:
			body, _ := json.Marshal(msg)
			var wire struct {
				Header struct {
					Event        string `json:"event"`
					ErrorCode    string `json:"error_code"`
					ErrorMessage string `json:"error_message"`
				} `json:"header"`
				Payload struct {
					Output struct {
						Sentence struct {
							Text        string `json:"text"`
							End         bool   `json:"end"`
							SentenceEnd bool   `json:"sentence_end"`
						} `json:"sentence"`
					} `json:"output"`
				} `json:"payload"`
			}
			if err := json.Unmarshal(body, &wire); err != nil {
				return stageError("DashScope", "parse", err)
			}
			switch wire.Header.Event {
			case "task-started":
				if !ready {
					ready = true
					events <- Event{Type: "ready", SessionID: id}
					for _, pcm := range pending {
						if err := conn.WriteMessage(websocket.BinaryMessage, pcm); err != nil {
							return stageError("DashScope", "send_audio", err)
						}
					}
					pending = nil
					if finishing && !finishSent {
						if err := conn.WriteJSON(dashScopeFinish(wireTaskID)); err != nil {
							return stageError("DashScope", "finish", err)
						}
						finishSent = true
					}
				}
			case "result-generated":
				if wire.Payload.Output.Sentence.End || wire.Payload.Output.Sentence.SentenceEnd {
					finals += wire.Payload.Output.Sentence.Text
					events <- Event{Type: "partial", SessionID: id, Text: finals}
				} else {
					events <- Event{Type: "partial", SessionID: id, Text: finals + wire.Payload.Output.Sentence.Text}
				}
			case "task-finished":
				if finishing && finishSent {
					taskFinished = true
					if finals != "" {
						events <- Event{Type: "final", SessionID: id, Text: finals}
					}
					return nil
				}
			case "task-failed":
				return stageError("DashScope", "provider_response", providerFailure("DashScope", wire.Header.ErrorCode, wire.Header.ErrorMessage))
			}
		}
	}
}
