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

type VolcengineSeedV3Adapter struct{}

const volcengineSeedV3Endpoint = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async"

func (a *VolcengineSeedV3Adapter) Test(ctx context.Context, cfg map[string]any) (string, error) {
	return readyProtocolTest(ctx, a, cfg)
}

func seedV3JSON(value any) ([]byte, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	var output bytes.Buffer
	writer := gzip.NewWriter(&output)
	if _, err = writer.Write(raw); err != nil {
		return nil, err
	}
	if err = writer.Close(); err != nil {
		return nil, err
	}
	return output.Bytes(), nil
}

func seedV3Frame(messageType, flags, serialization byte, payload []byte) []byte {
	frame := []byte{0x11, messageType<<4 | flags, serialization<<4 | 0x01, 0}
	length := make([]byte, 4)
	binary.BigEndian.PutUint32(length, uint32(len(payload)))
	return append(append(frame, length...), payload...)
}

func seedV3AudioFrame(last bool, payload []byte) []byte {
	flags := byte(0)
	if last {
		flags = 2
	}
	return seedV3Frame(2, flags, 0, payload)
}

func seedV3StartRequest(id string) map[string]any {
	return map[string]any{
		"user":  map[string]any{"uid": id},
		"audio": map[string]any{"format": "pcm", "codec": "raw", "rate": 16000, "bits": 16, "channel": 1},
		"request": map[string]any{
			"model_name":      "bigmodel",
			"enable_itn":      true,
			"enable_punc":     true,
			"enable_ddc":      true,
			"show_utterances": true,
			"result_type":     "full",
		},
	}
}

func seedV3Headers(cfg map[string]any, connectID string) http.Header {
	header := http.Header{}
	header.Set("X-Api-App-Key", value(cfg, "appId"))
	header.Set("X-Api-Access-Key", value(cfg, "accessToken"))
	header.Set("X-Api-Resource-Id", value(cfg, "resourceId"))
	header.Set("X-Api-Connect-Id", connectID)
	return header
}

func decodeSeedV3Frame(data []byte) (map[string]any, error) {
	if len(data) < 8 || data[0]&0x0f < 1 {
		return nil, errors.New("Seed v3 invalid frame")
	}
	headerLength := int(data[0]&0x0f) * 4
	if len(data) < headerLength+4 {
		return nil, errors.New("Seed v3 invalid header")
	}
	messageType := data[1] >> 4
	flags := data[1] & 0x0f
	offset := headerLength
	var errorCode uint32
	var sequence int32
	if messageType == 0x0f {
		if len(data) < offset+8 {
			return nil, errors.New("Seed v3 invalid error frame")
		}
		errorCode = binary.BigEndian.Uint32(data[offset : offset+4])
		offset += 4
	} else if flags&0x01 != 0 {
		if len(data) < offset+8 {
			return nil, errors.New("Seed v3 invalid sequence frame")
		}
		sequence = int32(binary.BigEndian.Uint32(data[offset : offset+4]))
		offset += 4
	}
	payloadLength := int(binary.BigEndian.Uint32(data[offset : offset+4]))
	if len(data) < offset+4+payloadLength {
		return nil, errors.New("Seed v3 invalid payload")
	}
	payload := data[offset+4 : offset+4+payloadLength]
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
	message["_last"] = flags == 2 || flags == 3 || sequence < 0
	return message, nil
}

func (a *VolcengineSeedV3Adapter) Run(ctx context.Context, id string, cfg map[string]any, commands <-chan Command, events chan<- Event) error {
	connectID := uuid.NewString()
	header := seedV3Headers(cfg, connectID)
	endpoint, err := websocketEndpoint(cfg, volcengineSeedV3Endpoint)
	if err != nil {
		return stageError("VolcengineSeedV3", "validate", err)
	}
	conn, response, err := websocket.DefaultDialer.DialContext(ctx, endpoint, header)
	if err != nil {
		return stageError("VolcengineSeedV3", "connect", websocketConnectError(response, err))
	}
	defer conn.Close()
	start, err := seedV3JSON(seedV3StartRequest(id))
	if err != nil {
		return stageError("VolcengineSeedV3", "start", err)
	}
	if err = conn.WriteMessage(websocket.BinaryMessage, seedV3Frame(1, 0, 1, start)); err != nil {
		return stageError("VolcengineSeedV3", "start", err)
	}
	incoming := make(chan map[string]any, 8)
	readErr := make(chan error, 1)
	go func() {
		for {
			kind, data, readError := conn.ReadMessage()
			if readError != nil {
				readErr <- stageError("VolcengineSeedV3", "receive", readError)
				return
			}
			if kind != websocket.BinaryMessage {
				readErr <- stageError("VolcengineSeedV3", "parse", errors.New("expected binary frame"))
				return
			}
			message, decodeError := decodeSeedV3Frame(data)
			if decodeError != nil {
				readErr <- stageError("VolcengineSeedV3", "parse", decodeError)
				return
			}
			incoming <- message
		}
	}()
	ready := false
	finishing := false
	finishSent := false
	completed := false
	pending := make([][]byte, 0, 32)
	pendingSequences := make([]uint32, 0, 32)
	var heldAudio *AudioChunk
	lastText := ""
	sendAudio := func(chunk *AudioChunk, last bool) error {
		compressed, compressError := gzipBytes(chunk.PCM)
		if compressError != nil {
			return stageError("VolcengineSeedV3", "send_audio", compressError)
		}
		frame := seedV3AudioFrame(last, compressed)
		if err := conn.WriteMessage(websocket.BinaryMessage, frame); err != nil {
			stage := "send_audio"
			if last {
				stage = "finish"
			}
			return stageError("VolcengineSeedV3", stage, err)
		}
		return nil
	}
	holdAudio := func(chunk AudioChunk) error {
		if heldAudio != nil {
			if err := sendAudio(heldAudio, false); err != nil {
				return err
			}
		}
		copyChunk := AudioChunk{Sequence: chunk.Sequence, PCM: append([]byte(nil), chunk.PCM...)}
		heldAudio = &copyChunk
		return nil
	}
	finishAudio := func() error {
		if heldAudio == nil {
			heldAudio = &AudioChunk{Sequence: 0}
		}
		err := sendAudio(heldAudio, true)
		heldAudio = nil
		return err
	}
	for {
		select {
		case <-ctx.Done():
			return nil
		case readError := <-readErr:
			if completed {
				return nil
			}
			if finishing && finishSent {
				return stageError("VolcengineSeedV3", "close", readError)
			}
			return readError
		case command := <-commands:
			if command.Cancel {
				return nil
			}
			if command.Audio != nil {
				if !ready {
					pending = append(pending, append([]byte(nil), command.Audio.PCM...))
					pendingSequences = append(pendingSequences, command.Audio.Sequence)
				} else if err := holdAudio(*command.Audio); err != nil {
					return err
				}
			}
			if command.Finish {
				finishing = true
				if ready && !finishSent {
					if err := finishAudio(); err != nil {
						return err
					}
					finishSent = true
				}
			}
		case message := <-incoming:
			if errorValue, ok := message["error"].(string); ok && errorValue != "" {
				return stageError("VolcengineSeedV3", "provider_response", providerFailure("Volcengine Seed v3", fmt.Sprint(message["code"]), errorValue))
			}
			if code := int(number(message["code"])); code != 0 && code != 1000 {
				return stageError("VolcengineSeedV3", "provider_response", providerFailure("Volcengine Seed v3", fmt.Sprint(code), valueString(message, "message")))
			}
			if !ready {
				ready = true
				events <- Event{Type: "ready", SessionID: id}
				for index, pcm := range pending {
					if err := holdAudio(AudioChunk{Sequence: pendingSequences[index], PCM: pcm}); err != nil {
						return err
					}
				}
				pending = nil
				pendingSequences = nil
				if finishing && !finishSent {
					if err := finishAudio(); err != nil {
						return err
					}
					finishSent = true
				}
			}
			if result, ok := message["result"].(map[string]any); ok {
				if text, ok := result["text"].(string); ok {
					lastText = text
					events <- Event{Type: "partial", SessionID: id, Text: text}
				}
			}
			lastPackage, _ := message["is_last_package"].(bool)
			lastFrame, _ := message["_last"].(bool)
			if (lastPackage || lastFrame) && finishing {
				completed = true
				if lastText != "" {
					events <- Event{Type: "final", SessionID: id, Text: lastText}
				}
				return nil
			}
		}
	}
}
