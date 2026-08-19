package stt

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/klauspost/compress/gzip"
)

type VolcengineV2Adapter struct{}

const volcengineV2Endpoint = "wss://openspeech.bytedance.com/api/v2/asr"

func volcV2Authorization(token string) string { return "Bearer; " + token }

func (a *VolcengineV2Adapter) Test(ctx context.Context, cfg map[string]any) (string, error) {
	return readyProtocolTest(ctx, a, cfg)
}
func gzipJSON(v any) ([]byte, error) {
	raw, e := json.Marshal(v)
	if e != nil {
		return nil, e
	}
	var out bytes.Buffer
	writer := gzip.NewWriter(&out)
	if _, e = writer.Write(raw); e != nil {
		return nil, e
	}
	if e = writer.Close(); e != nil {
		return nil, e
	}
	return out.Bytes(), nil
}

func gzipBytes(payload []byte) ([]byte, error) {
	var out bytes.Buffer
	writer := gzip.NewWriter(&out)
	if _, err := writer.Write(payload); err != nil {
		return nil, err
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

func volcV2Frame(messageType, flags, serialization, compression byte, payload []byte) []byte {
	frame := []byte{0x11, messageType<<4 | flags, serialization<<4 | compression, 0}
	size := make([]byte, 4)
	binary.BigEndian.PutUint32(size, uint32(len(payload)))
	return append(append(frame, size...), payload...)
}

func volcV2ResponseOK(message map[string]any) bool {
	code := int(number(message["code"]))
	text, _ := message["message"].(string)
	return code == 0 || code == 1000 || text == "Success"
}

func volcV2ResponseNoSpeech(message map[string]any) bool {
	return int(number(message["code"])) == 1013
}

func decodeVolcV2Frame(data []byte) (map[string]any, error) {
	if len(data) < 8 {
		return nil, errors.New("volcengine v2 short frame")
	}
	headerLen := int(data[0]&0x0f) * 4
	if headerLen < 4 || len(data) < headerLen+4 {
		return nil, errors.New("volcengine v2 invalid header")
	}
	messageType := data[1] >> 4
	flags := data[1] & 0x0f
	offset := headerLen
	var errorCode uint32
	var sequence int32
	if messageType == 0x0f {
		if len(data) < offset+8 {
			return nil, errors.New("volcengine v2 invalid error frame")
		}
		errorCode = binary.BigEndian.Uint32(data[offset : offset+4])
		offset += 4
	} else if messageType == 0x0b || flags&0x01 != 0 {
		if len(data) < offset+8 {
			return nil, errors.New("volcengine v2 invalid sequence frame")
		}
		sequence = int32(binary.BigEndian.Uint32(data[offset : offset+4]))
		offset += 4
	}
	payloadLen := int(binary.BigEndian.Uint32(data[offset : offset+4]))
	if payloadLen < 0 || len(data) < offset+4+payloadLen {
		return nil, errors.New("volcengine v2 invalid payload")
	}
	payload := append([]byte(nil), data[offset+4:offset+4+payloadLen]...)
	if data[2]&0x0f == 1 {
		reader, err := gzip.NewReader(bytes.NewReader(payload))
		if err != nil {
			return nil, err
		}
		payload, err = io.ReadAll(reader)
		_ = reader.Close()
		if err != nil {
			return nil, err
		}
	}
	if messageType == 0x0f {
		return map[string]any{"code": float64(errorCode), "message": string(payload)}, nil
	}
	var message map[string]any
	if err := json.Unmarshal(payload, &message); err != nil {
		return nil, err
	}
	message["_sequence"] = float64(sequence)
	message["_last"] = flags == 2 || flags == 3 || sequence < 0 || number(message["sequence"]) < 0
	return message, nil
}

func volcV2ResultText(message map[string]any) string {
	result := message["result"]
	if object, ok := result.(map[string]any); ok {
		return valueString(object, "text")
	}
	if items, ok := result.([]any); ok && len(items) > 0 {
		if object, ok := items[0].(map[string]any); ok {
			return valueString(object, "text")
		}
	}
	for _, key := range []string{"payload", "data"} {
		if wrapper, ok := message[key].(map[string]any); ok {
			if nested, ok := wrapper["result"].(map[string]any); ok {
				if text := valueString(nested, "text"); text != "" {
					return text
				}
			}
		}
	}
	return ""
}

func volcV2ResponseComplete(message map[string]any, finishing bool) bool {
	if !finishing {
		return false
	}
	lastPackage, _ := message["is_last_package"].(bool)
	lastFrame, _ := message["_last"].(bool)
	return lastPackage || lastFrame
}

func volcV2StartRequest(cfg map[string]any, id, requestID string) map[string]any {
	return map[string]any{
		"app": map[string]any{
			"appid": value(cfg, "appId"), "token": value(cfg, "accessToken"), "cluster": value(cfg, "cluster"),
		},
		"user":  map[string]any{"uid": id},
		"audio": map[string]any{"format": "raw", "rate": 16000, "bits": 16, "channel": 1, "codec": "raw"},
		"request": map[string]any{
			"reqid": requestID, "nbest": 1,
			"workflow":        "audio_in,resample,partition,vad,fe,decode,itn,nlu_punctuate",
			"show_utterances": true, "result_type": "full", "sequence": 1,
		},
	}
}
func (a *VolcengineV2Adapter) Run(ctx context.Context, id string, cfg map[string]any, commands <-chan Command, events chan<- Event) error {
	endpoint, err := websocketEndpoint(cfg, volcengineV2Endpoint)
	if err != nil {
		return stageError("VolcengineV2", "validate", err)
	}
	header := http.Header{}
	header.Set("Authorization", volcV2Authorization(value(cfg, "accessToken")))
	conn, response, err := websocket.DefaultDialer.DialContext(ctx, endpoint, header)
	if err != nil {
		return stageError("VolcengineV2", "connect", websocketConnectError(response, err))
	}
	defer func() { _ = conn.Close() }()
	requestID := uuid.NewString()
	first, err := gzipJSON(volcV2StartRequest(cfg, id, requestID))
	if err != nil {
		return stageError("VolcengineV2", "start", err)
	}
	if err = writeProviderMessage(conn, websocket.BinaryMessage, volcV2Frame(1, 0, 1, 1, first)); err != nil {
		return stageError("VolcengineV2", "start", err)
	}
	return runVolcV2Loop(ctx, conn, id, commands, events)
}
func runVolcV2Loop(ctx context.Context, conn *websocket.Conn, id string, commands <-chan Command, events chan<- Event) error {
	incoming := make(chan map[string]any, 8)
	readErr := make(chan error, 1)
	go func() {
		for {
			messageType, data, e := conn.ReadMessage()
			if e != nil {
				readErr <- stageError("VolcengineV2", "receive", e)
				return
			}
			if messageType != websocket.BinaryMessage {
				readErr <- stageError("VolcengineV2", "parse", errors.New("expected binary frame"))
				return
			}
			msg, e := decodeVolcV2Frame(data)
			if e != nil {
				readErr <- stageError("VolcengineV2", "parse", e)
				return
			}
			if !emitIncoming(ctx, incoming, msg) {
				return
			}
		}
	}()
	finishing := false
	finishSent := false
	ready := false
	pending := make([][]byte, 0, 32)
	lastText := ""
	for {
		select {
		case <-ctx.Done():
			return nil
		case e := <-readErr:
			if finishing && finishSent && isWebSocketCloseError(e, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
				if lastText != "" {
					if !emitEvent(ctx, events, Event{Type: "final", SessionID: id, Text: lastText}) {
						return ctx.Err()
					}
				}
				return nil
			}
			if finishing && finishSent {
				return stageError("VolcengineV2", "close", e)
			}
			return e
		case cmd := <-commands:
			if cmd.Cancel {
				return nil
			}
			if cmd.Audio != nil {
				if !ready {
					pending = append(pending, append([]byte(nil), cmd.Audio.PCM...))
				} else if compressed, e := gzipBytes(cmd.Audio.PCM); e != nil {
					return stageError("VolcengineV2", "send_audio", e)
				} else if e := writeProviderMessage(conn, websocket.BinaryMessage, volcV2Frame(2, 0, 0, 1, compressed)); e != nil {
					return stageError("VolcengineV2", "send_audio", e)
				}
			}
			if cmd.Finish {
				finishing = true
				if ready && !finishSent {
					compressed, compressErr := gzipBytes(nil)
					if compressErr != nil {
						return stageError("VolcengineV2", "finish", compressErr)
					}
					if e := writeProviderMessage(conn, websocket.BinaryMessage, volcV2Frame(2, 2, 0, 1, compressed)); e != nil {
						return stageError("VolcengineV2", "finish", e)
					}
					finishSent = true
				}
			}
		case msg := <-incoming:
			if volcV2ResponseNoSpeech(msg) {
				return nil
			}
			if !volcV2ResponseOK(msg) {
				return stageError("VolcengineV2", "provider_response", providerFailure("Volcengine v2", fmt.Sprint(msg["code"]), valueString(msg, "message")))
			}
			if !ready {
				ready = true
				if !emitEvent(ctx, events, Event{Type: "ready", SessionID: id}) {
					return ctx.Err()
				}
				for _, pcm := range pending {
					compressed, compressErr := gzipBytes(pcm)
					if compressErr != nil {
						return stageError("VolcengineV2", "send_audio", compressErr)
					}
					if e := writeProviderMessage(conn, websocket.BinaryMessage, volcV2Frame(2, 0, 0, 1, compressed)); e != nil {
						return stageError("VolcengineV2", "send_audio", e)
					}
				}
				pending = nil
				if finishing && !finishSent {
					compressed, compressErr := gzipBytes(nil)
					if compressErr != nil {
						return stageError("VolcengineV2", "finish", compressErr)
					}
					if e := writeProviderMessage(conn, websocket.BinaryMessage, volcV2Frame(2, 2, 0, 1, compressed)); e != nil {
						return stageError("VolcengineV2", "finish", e)
					}
					finishSent = true
				}
			}
			if text := volcV2ResultText(msg); text != "" {
				lastText = text
				if !emitEvent(ctx, events, Event{Type: "partial", SessionID: id, Text: text}) {
					return ctx.Err()
				}
			}
			if volcV2ResponseComplete(msg, finishing) {
				if lastText != "" {
					if !emitEvent(ctx, events, Event{Type: "final", SessionID: id, Text: lastText}) {
						return ctx.Err()
					}
				}
				return nil
			}
		}
	}
}
