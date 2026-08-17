package stt

import (
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"fmt"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

type TencentCloudAdapter struct{}

const tencentEndpoint = "wss://asr.cloud.tencent.com/asr/v2/"

func (a *TencentCloudAdapter) Test(ctx context.Context, cfg map[string]any) (string, error) {
	return readyProtocolTest(ctx, a, cfg)
}

func tencentSignedURL(appID, engine, secretID, secretKey, voiceID string, timestamp int64) string {
	path := fmt.Sprintf("asr.cloud.tencent.com/asr/v2/%s", appID)
	q := url.Values{
		"convert_num_mode":  {"1"},
		"engine_model_type": {engine},
		"expired":           {strconv.FormatInt(timestamp+24*60*60, 10)},
		"filter_dirty":      {"1"},
		"filter_modal":      {"2"},
		"filter_punc":       {"0"},
		"needvad":           {"0"},
		"nonce":             {strconv.FormatUint(uint64(uuid.New().ID()), 10)},
		"secretid":          {secretID},
		"timestamp":         {strconv.FormatInt(timestamp, 10)},
		"voice_format":      {"1"},
		"voice_id":          {voiceID},
		"word_info":         {"0"},
	}
	signed := path + "?" + q.Encode()
	mac := hmac.New(sha1.New, []byte(secretKey))
	_, _ = mac.Write([]byte(signed))
	q.Set("signature", base64.StdEncoding.EncodeToString(mac.Sum(nil)))
	return tencentEndpoint + appID + "?" + q.Encode()
}

func (a *TencentCloudAdapter) Run(ctx context.Context, id string, cfg map[string]any, commands <-chan Command, events chan<- Event) error {
	voiceID := uuid.NewString()
	conn, response, err := websocket.DefaultDialer.DialContext(ctx, tencentSignedURL(value(cfg, "appId"), value(cfg, "engineModelType"), value(cfg, "secretId"), value(cfg, "secretKey"), voiceID, time.Now().Unix()), nil)
	if err != nil {
		return stageError("Tencent", "connect", websocketConnectError(response, err))
	}
	defer conn.Close()
	time.Sleep(25 * time.Millisecond)
	incoming := make(chan map[string]any, 8)
	readErr := make(chan error, 1)
	go func() {
		for {
			var msg map[string]any
			if e := conn.ReadJSON(&msg); e != nil {
				readErr <- stageError("Tencent", "receive", e)
				return
			}
			incoming <- msg
		}
	}()
	events <- Event{Type: "ready", SessionID: id}
	fragments := map[int]string{}
	finishSent := false
	endSeen := false
	for {
		select {
		case <-ctx.Done():
			return nil
		case e := <-readErr:
			if finishSent && (endSeen || isWebSocketCloseError(e, websocket.CloseNormalClosure, websocket.CloseGoingAway)) {
				if len(fragments) > 0 {
					events <- Event{Type: "final", SessionID: id, Text: mergeTencentFragments(fragments)}
				}
				return nil
			}
			if finishSent {
				return stageError("Tencent", "close", e)
			}
			return e
		case cmd := <-commands:
			if cmd.Cancel {
				return nil
			}
			if cmd.Audio != nil {
				if e := conn.WriteMessage(websocket.BinaryMessage, cmd.Audio.PCM); e != nil {
					return stageError("Tencent", "send_audio", e)
				}
			}
			if cmd.Finish {
				finishSent = true
				if e := conn.WriteJSON(map[string]any{"type": "end"}); e != nil {
					return stageError("Tencent", "finish", e)
				}
			}
		case msg := <-incoming:
			if code, ok := msg["code"].(float64); ok && code != 0 {
				return stageError("Tencent", "provider_response", providerFailure("Tencent Cloud", strconv.Itoa(int(code)), valueString(msg, "message")))
			}
			if idx, transcript, ok := tencentResult(msg); ok {
				fragments[idx] = transcript
				events <- Event{Type: "partial", SessionID: id, Text: mergeTencentFragments(fragments)}
			}
			if finishSent && tencentMessageComplete(msg) {
				endSeen = true
				if len(fragments) > 0 {
					events <- Event{Type: "final", SessionID: id, Text: mergeTencentFragments(fragments)}
				}
				return nil
			}
		}
	}
}
func number(v any) float64 { n, _ := v.(float64); return n }
func valueString(message map[string]any, key string) string {
	text, _ := message[key].(string)
	return text
}

func tencentMessageComplete(message map[string]any) bool {
	return message["type"] == "end" || number(message["final"]) == 1
}

func tencentResult(message map[string]any) (int, string, bool) {
	result, ok := message["result"].(map[string]any)
	if !ok {
		return 0, "", false
	}
	text, ok := result["voice_text_str"].(string)
	return int(number(result["index"])), text, ok
}

func mergeTencentFragments(fragments map[int]string) string {
	keys := make([]int, 0, len(fragments))
	for key := range fragments {
		keys = append(keys, key)
	}
	sort.Ints(keys)
	var merged strings.Builder
	for _, key := range keys {
		merged.WriteString(fragments[key])
	}
	return merged.String()
}
