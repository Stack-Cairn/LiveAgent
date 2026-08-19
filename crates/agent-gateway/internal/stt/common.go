package stt

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

const providerWriteTimeout = 10 * time.Second

// emitEvent never lets a provider goroutine block forever when its consumer
// (usually the WebSocket writer) has stopped reading. Cancellation must be
// able to unwind the provider and close its upstream connection.
func emitEvent(ctx context.Context, events chan<- Event, event Event) bool {
	select {
	case events <- event:
		return true
	case <-ctx.Done():
		return false
	}
}

// emitIncoming is the adapter-local counterpart of emitEvent: the provider
// read goroutine must not stay blocked on a full incoming channel after the
// session context is cancelled.
func emitIncoming(ctx context.Context, incoming chan<- map[string]any, msg map[string]any) bool {
	select {
	case incoming <- msg:
		return true
	case <-ctx.Done():
		return false
	}
}

func writeProviderMessage(conn *websocket.Conn, messageType int, data []byte) error {
	if err := conn.SetWriteDeadline(time.Now().Add(providerWriteTimeout)); err != nil {
		return err
	}
	return conn.WriteMessage(messageType, data)
}

func writeProviderJSON(conn *websocket.Conn, value any) error {
	if err := conn.SetWriteDeadline(time.Now().Add(providerWriteTimeout)); err != nil {
		return err
	}
	return conn.WriteJSON(value)
}

type ResultError struct {
	Result string
	Err    error
}

func (e *ResultError) Error() string { return e.Err.Error() }
func (e *ResultError) Unwrap() error { return e.Err }

type StageError struct {
	Provider string
	Stage    string
	Err      error
}

func (e *StageError) Error() string {
	return fmt.Sprintf("[%s/%s] %s", e.Provider, e.Stage, e.Err)
}

func (e *StageError) Unwrap() error { return e.Err }

func stageError(provider, stage string, err error) error {
	if err == nil {
		return nil
	}
	return &StageError{Provider: provider, Stage: stage, Err: err}
}

func isWebSocketCloseError(err error, codes ...int) bool {
	var closeErr *websocket.CloseError
	if !errors.As(err, &closeErr) {
		return false
	}
	for _, code := range codes {
		if closeErr.Code == code {
			return true
		}
	}
	return false
}

func websocketConnectError(response *http.Response, err error) error {
	if response == nil {
		return err
	}
	if response.Body != nil {
		_ = response.Body.Close()
	}
	result := "protocol_failed"
	if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
		result = "authentication_failed"
	} else if response.StatusCode >= http.StatusInternalServerError {
		result = "network_failed"
	}
	return &ResultError{
		Result: result,
		Err:    fmt.Errorf("STT provider WebSocket handshake failed with HTTP %d", response.StatusCode),
	}
}

func resultForError(err error) string {
	var classified *ResultError
	if errors.As(err, &classified) && classified.Result != "" {
		return classified.Result
	}
	return classifyError(err)
}

func classifyError(err error) string {
	if err == nil {
		return "connected_no_speech"
	}
	if noSpeechError(err) {
		return "connected_no_speech"
	}
	message := strings.ToLower(err.Error())
	if strings.Contains(message, "timeout") || strings.Contains(message, "deadline") {
		return "timeout"
	}
	var netErr net.Error
	if errors.As(err, &netErr) {
		return "network_failed"
	}
	if strings.Contains(message, "auth") || strings.Contains(message, "鉴权") || strings.Contains(message, "unauthor") || strings.Contains(message, "invalid api") || strings.Contains(message, "appid") {
		return "authentication_failed"
	}
	return "protocol_failed"
}

func noSpeechError(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "no valid speeches") ||
		strings.Contains(message, "no speech") ||
		strings.Contains(message, "未检测到有效语音") ||
		strings.Contains(message, "未发现有效语音") ||
		strings.Contains(message, "3301") ||
		strings.Contains(message, "-3005") ||
		strings.Contains(message, "1013")
}

func value(cfg map[string]any, key string) string { v, _ := cfg[key].(string); return v }

func websocketEndpoint(cfg map[string]any, fallback string) (string, error) {
	endpoint := strings.TrimSpace(value(cfg, "websocketUrl"))
	if endpoint == "" {
		endpoint = fallback
	}
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Scheme != "wss" || parsed.Host == "" || parsed.User != nil {
		return "", &ResultError{Result: "protocol_failed", Err: errors.New("STT WebSocket URL must be an absolute wss:// URL without user information")}
	}
	return endpoint, nil
}

func providerFailure(provider, code, message string) error {
	detail := strings.TrimSpace(code)
	if text := strings.TrimSpace(message); text != "" {
		if detail != "" {
			detail += ": "
		}
		detail += text
	}
	if detail == "" {
		detail = "provider rejected the request"
	}
	result := "protocol_failed"
	lower := strings.ToLower(detail)
	if noSpeechError(errors.New(detail)) {
		result = "connected_no_speech"
	} else if strings.Contains(lower, "auth") || strings.Contains(lower, "unauthor") || strings.Contains(lower, "forbidden") || strings.Contains(lower, "api key") || strings.Contains(lower, "access key") || strings.Contains(lower, "token") || strings.Contains(lower, "signature") || strings.Contains(lower, "secret") || strings.Contains(lower, "鉴权") {
		result = "authentication_failed"
	}
	return &ResultError{Result: result, Err: errors.New(provider + " rejected the request (" + detail + ")")}
}

// readyProtocolTest mirrors the working desktop reference implementation:
// providers with an explicit ready state have already proved endpoint,
// authentication, and start-request compatibility at that point. Their
// provider-specific finish protocol remains enforced for real recognition,
// but is not used to decide whether saved configuration is valid.
func readyProtocolTest(parent context.Context, adapter Adapter, cfg map[string]any) (string, error) {
	ctx, cancel := context.WithTimeout(parent, 10*time.Second)
	defer cancel()
	commands := make(chan Command, 1)
	events := make(chan Event, 8)
	done := make(chan error, 1)
	go func() { done <- adapter.Run(ctx, "connection-test", cfg, commands, events) }()
	for {
		select {
		case event := <-events:
			switch event.Type {
			case "ready":
				commands <- Command{Cancel: true}
				select {
				case err := <-done:
					if err != nil {
						return resultForError(err), err
					}
				case <-time.After(time.Second):
					// Authentication and the provider start request are already
					// proven. Context cancellation below releases a slow close.
				}
				return "connected", nil
			case "error":
				err := errors.New(event.Message)
				return resultForError(err), err
			}
		case err := <-done:
			if err != nil {
				return resultForError(err), err
			}
			return "protocol_failed", errors.New("STT provider closed before reporting ready")
		case <-ctx.Done():
			return "timeout", errors.New("waiting for STT provider ready state timed out")
		}
	}
}

func silentProtocolTest(ctx context.Context, adapter Adapter, cfg map[string]any) (string, error) {
	// The ready and provider-finish windows are independent. A slow but valid
	// handshake must not consume the time reserved for the finish acknowledgement.
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	commands := make(chan Command, 16)
	events := make(chan Event, 16)
	done := make(chan error, 1)
	go func() { done <- adapter.Run(ctx, "connection-test", cfg, commands, events) }()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	ready := false
	finishSent := false
	recognized := false
	sequence := uint32(0)
	readyTimeout := time.After(10 * time.Second)
	var finishTimeout <-chan time.Time
	for {
		select {
		case event := <-events:
			if event.Type == "error" {
				err := errors.New(event.Message)
				if finishSent && noSpeechError(err) {
					return "connected_no_speech", nil
				}
				return resultForError(err), err
			}
			if event.Type == "ready" {
				ready = true
				readyTimeout = nil
			}
			if (event.Type == "partial" || event.Type == "final") && strings.TrimSpace(event.Text) != "" {
				recognized = true
			}
		case <-ticker.C:
			if !ready || finishSent {
				continue
			}
			if sequence < 10 {
				select {
				case commands <- Command{Audio: &AudioChunk{Sequence: sequence, PCM: make([]byte, 3200)}}:
					sequence++
				case <-ctx.Done():
					return "timeout", ctx.Err()
				}
				continue
			}
			select {
			case commands <- Command{Finish: true}:
				finishSent = true
				finishTimeout = time.After(5 * time.Second)
			case <-ctx.Done():
				return "timeout", ctx.Err()
			}
		case err := <-done:
			if err != nil {
				if finishSent && noSpeechError(err) {
					return "connected_no_speech", nil
				}
				return resultForError(err), err
			}
			if !ready {
				return "protocol_failed", errors.New("STT provider closed before reporting ready")
			}
			if !finishSent {
				return "protocol_failed", errors.New("STT provider closed before the test audio was finished")
			}
			if recognized {
				return "connected", nil
			}
			return "connected_no_speech", nil
		case <-readyTimeout:
			return "timeout", errors.New("waiting for STT provider ready state timed out")
		case <-finishTimeout:
			return "timeout", errors.New("STT provider connected but finish acknowledgement timed out")
		case <-ctx.Done():
			return "timeout", ctx.Err()
		}
	}
}
