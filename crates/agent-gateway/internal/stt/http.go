package stt

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/gorilla/websocket"
	"github.com/liveagent/agent-gateway/internal/auth"
	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/protocol/pbws"
	"github.com/liveagent/agent-gateway/internal/protocol/shared"
	"google.golang.org/protobuf/proto"
)

const connectionTestHTTPTimeout = 22 * time.Second

func (m *Manager) SettingsHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method {
		case http.MethodGet:
			settings, err := m.store.Get(r.Context())
			if err != nil {
				http.Error(w, "STT settings unavailable", 500)
				return
			}
			_ = json.NewEncoder(w).Encode(settings)
		case http.MethodPut:
			var incoming Settings
			if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&incoming); err != nil {
				http.Error(w, "invalid STT settings", 400)
				return
			}
			settings, err := m.store.Update(r.Context(), incoming)
			if err != nil {
				http.Error(w, "STT settings update failed", 400)
				return
			}
			_ = json.NewEncoder(w).Encode(settings)
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	})
}

func (m *Manager) TestHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		provider := strings.TrimSpace(r.URL.Query().Get("provider"))
		// The provider probe reserves up to 10 seconds for ready and another
		// 5 seconds for finish acknowledgement. Keep the HTTP request alive for
		// the complete protocol lifecycle plus scheduling overhead.
		ctx, cancel := context.WithTimeout(r.Context(), connectionTestHTTPTimeout)
		defer cancel()
		result, err := m.Test(ctx, provider)
		if err != nil && result == "" {
			result = "protocol_failed"
		}
		w.Header().Set("Content-Type", "application/json")
		response := map[string]string{"result": result}
		if err != nil {
			message := []rune(err.Error())
			if len(message) > 240 {
				message = message[:240]
			}
			response["message"] = string(message)
		}
		_ = json.NewEncoder(w).Encode(response)
	})
}

func (m *Manager) WebSocketHandler(token string) http.Handler {
	upgrader := websocket.Upgrader{Subprotocols: []string{pbws.Subprotocol}, CheckOrigin: shared.OriginAllowed}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer func() { _ = conn.Close() }()
		conn.SetReadLimit(64 << 10)
		messageType, data, err := conn.ReadMessage()
		if err != nil || messageType != websocket.BinaryMessage {
			return
		}
		var helloFrame gatewayv2.SttClientFrame
		if proto.Unmarshal(data, &helloFrame) != nil || helloFrame.GetHello() == nil ||
			helloFrame.GetHello().GetProtocolVersion() != pbws.ProtocolVersion ||
			!auth.ValidateToken(helloFrame.GetHello().GetToken(), token) {
			_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(4401, "unauthorized"), time.Now().Add(time.Second))
			return
		}
		if !writeSttFrame(conn, &gatewayv2.SttServerFrame{Payload: &gatewayv2.SttServerFrame_Hello{Hello: &gatewayv2.SttServerHello{Ok: true}}}) {
			return
		}
		events := make(chan Event, 64)
		writerStop := make(chan struct{})
		writerDone := make(chan struct{})
		var activeID string
		var nextSequence uint32
		go func() {
			defer close(writerDone)
			for {
				select {
				case <-writerStop:
					return
				case event := <-events:
					if !writeSttEvent(conn, event) {
						// Stop the read loop as soon as the client can no longer
						// receive events; its deferred cleanup cancels the adapter
						// context so event delivery cannot block the provider.
						_ = conn.Close()
						return
					}
				}
			}
		}()
		defer func() {
			if activeID != "" {
				m.Cancel(activeID)
			}
			close(writerStop)
			<-writerDone
		}()
		windowStart := time.Now()
		frames := 0
		for {
			kind, payload, readErr := conn.ReadMessage()
			if readErr != nil {
				return
			}
			if time.Since(windowStart) >= time.Second {
				windowStart = time.Now()
				frames = 0
			}
			frames++
			if frames > 120 {
				return
			}
			if kind != websocket.BinaryMessage {
				return
			}
			var frame gatewayv2.SttClientFrame
			if proto.Unmarshal(payload, &frame) != nil {
				return
			}
			switch payload := frame.GetPayload().(type) {
			case *gatewayv2.SttClientFrame_Start:
				if activeID != "" || payload.Start.GetSessionId() == "" || m.Start(r.Context(), payload.Start.GetSessionId(), payload.Start.GetProvider(), events) != nil {
					return
				}
				activeID = payload.Start.GetSessionId()
				nextSequence = 0
			case *gatewayv2.SttClientFrame_Audio:
				if activeID == "" || payload.Audio.GetSessionId() != activeID || payload.Audio.GetSequence() != nextSequence || len(payload.Audio.GetPcm()) == 0 || len(payload.Audio.GetPcm())%2 != 0 || len(payload.Audio.GetPcm()) > 6400 || m.Send(activeID, Command{Audio: &AudioChunk{Sequence: payload.Audio.GetSequence(), PCM: append([]byte(nil), payload.Audio.GetPcm()...)}}) != nil {
					return
				}
				nextSequence++
			case *gatewayv2.SttClientFrame_Stop:
				if activeID == "" || payload.Stop.GetSessionId() != activeID || m.Send(activeID, Command{Finish: true}) != nil {
					return
				}
			case *gatewayv2.SttClientFrame_Cancel:
				if activeID != "" && payload.Cancel.GetSessionId() == activeID {
					m.Cancel(activeID)
					activeID = ""
				}
			}
		}
	})
}

func writeSttFrame(conn *websocket.Conn, frame *gatewayv2.SttServerFrame) bool {
	data, err := proto.Marshal(frame)
	if err != nil || conn.SetWriteDeadline(time.Now().Add(10*time.Second)) != nil {
		return false
	}
	return conn.WriteMessage(websocket.BinaryMessage, data) == nil
}

func writeSttEvent(conn *websocket.Conn, event Event) bool {
	var frame *gatewayv2.SttServerFrame
	switch event.Type {
	case "ready":
		frame = &gatewayv2.SttServerFrame{Payload: &gatewayv2.SttServerFrame_Ready{Ready: &gatewayv2.SttTextEvent{SessionId: event.SessionID}}}
	case "partial":
		frame = &gatewayv2.SttServerFrame{Payload: &gatewayv2.SttServerFrame_Partial{Partial: &gatewayv2.SttTextEvent{SessionId: event.SessionID, Text: event.Text}}}
	case "final":
		frame = &gatewayv2.SttServerFrame{Payload: &gatewayv2.SttServerFrame_Final{Final: &gatewayv2.SttTextEvent{SessionId: event.SessionID, Text: event.Text}}}
	case "error":
		frame = &gatewayv2.SttServerFrame{Payload: &gatewayv2.SttServerFrame_Error{Error: &gatewayv2.SttError{SessionId: event.SessionID, Code: event.Code, Message: event.Message}}}
	case "closed":
		frame = &gatewayv2.SttServerFrame{Payload: &gatewayv2.SttServerFrame_Closed{Closed: &gatewayv2.SttClosed{SessionId: event.SessionID}}}
	default:
		return true
	}
	return writeSttFrame(conn, frame)
}
