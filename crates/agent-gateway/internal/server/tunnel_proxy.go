package server

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/session"
)

const (
	tunnelBodyChunkSize        = 64 * 1024
	tunnelRequestBodyMaxBytes  = 32 * 1024 * 1024
	tunnelWebSocketDialTimeout = 30 * time.Second
	tunnelDataPlaneWSReadLimit = 16 * 1024 * 1024
)

var errTunnelRequestBodyTooLarge = errors.New("tunnel request body too large")

func publicTunnelProxy(sm *session.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if slug, ok := parseTunnelPublicPathWithoutTrailingSlash(r.URL.Path); ok {
			target := "/t/" + slug + "/"
			if r.URL.RawQuery != "" {
				target += "?" + r.URL.RawQuery
			}
			http.Redirect(w, r, target, http.StatusPermanentRedirect)
			return
		}

		slug, restPath, ok := parseTunnelPublicPath(r.URL.Path)
		if !ok {
			writeTunnelError(w, http.StatusNotFound, "tunnel not found")
			return
		}
		if r.URL.RawQuery != "" {
			restPath += "?" + r.URL.RawQuery
		}

		if isWebSocketUpgrade(r) {
			serveTunnelWebSocket(w, r, sm, slug, restPath)
			return
		}
		serveTunnelHTTP(w, r, sm, slug, restPath)
	}
}

func serveTunnelHTTP(
	w http.ResponseWriter,
	r *http.Request,
	sm *session.Manager,
	slug string,
	restPath string,
) {
	streamID := "h-" + uuid.NewString()
	lease, err := sm.AcquireTunnel(slug, streamID)
	if err != nil {
		writeTunnelAcquireError(w, err)
		return
	}
	rewrite := tunnelRewrite{slug: lease.Slug(), targetURL: lease.TargetURL()}

	ctx, cancel := context.WithCancel(r.Context())
	completed := false
	defer func() {
		cancel()
		if !completed {
			_ = sm.SendTunnelFrameToAgent(lease.AgentID(), &gatewayv2.TunnelFrame{
				StreamId: streamID,
				Kind:     gatewayv2.TunnelFrameKind_TUNNEL_FRAME_KIND_CANCEL,
			})
		}
		lease.Release()
	}()

	start := &gatewayv2.TunnelFrame{
		StreamId:  streamID,
		Kind:      gatewayv2.TunnelFrameKind_TUNNEL_FRAME_KIND_HTTP_REQUEST_START,
		TargetUrl: lease.TargetURL(),
		Method:    r.Method,
		Path:      restPath,
		Headers:   tunnelRequestHeaders(r, lease.Slug()),
	}
	if err := sm.SendTunnelFrameToAgent(lease.AgentID(), start); err != nil {
		writeTunnelAcquireError(w, err)
		return
	}

	bodyResult := make(chan error, 1)
	go streamTunnelHTTPRequestBody(ctx, sm, lease.AgentID(), streamID, r.Body, bodyResult)

	responseStarted := false
	responseHeadersWritten := false
	responseStatus := http.StatusOK
	responseHeaders := http.Header{}
	rewriteKind := tunnelResponseRewriteNone
	var rewriteBuffer []byte

	writeResponseHeaders := func() {
		if responseHeadersWritten {
			return
		}
		writeTunnelHTTPHeaders(w, responseHeaders)
		w.WriteHeader(responseStatus)
		responseHeadersWritten = true
	}
	// flushRewriteBuffer abandons rewriting and streams what was buffered.
	// Content-Length/ETag were already dropped at RESPONSE_START, so a
	// mid-stream abort terminates the chunked stream instead of lying about
	// the body length.
	flushRewriteBuffer := func() bool {
		rewriteKind = tunnelResponseRewriteNone
		writeResponseHeaders()
		if len(rewriteBuffer) > 0 {
			if _, err := w.Write(rewriteBuffer); err != nil {
				return false
			}
			rewriteBuffer = nil
		}
		flushTunnelResponse(w)
		return true
	}

	for {
		select {
		case <-r.Context().Done():
			return
		case <-lease.Done():
			if !responseStarted {
				writeTunnelError(w, http.StatusBadGateway, "tunnel stream closed")
			} else if rewriteKind != tunnelResponseRewriteNone {
				flushRewriteBuffer()
			}
			return
		case err := <-bodyResult:
			bodyResult = nil
			if errors.Is(err, errTunnelRequestBodyTooLarge) && !responseStarted {
				writeTunnelError(w, http.StatusRequestEntityTooLarge, "request body too large")
				return
			}
		case frame := <-lease.Frames():
			if frame == nil {
				continue
			}
			switch frame.GetKind() {
			case gatewayv2.TunnelFrameKind_TUNNEL_FRAME_KIND_HTTP_RESPONSE_START:
				if responseStarted {
					continue
				}
				responseStarted = true
				if status := int(frame.GetStatus()); status > 0 {
					responseStatus = status
				}
				responseHeaders = tunnelResponseHeaders(frame, rewrite)
				rewriteKind = tunnelResponseRewriteKindFor(r.Method, responseStatus, responseHeaders)
				if rewriteKind != tunnelResponseRewriteNone {
					responseHeaders.Del("Content-Length")
					responseHeaders.Del("Etag")
				} else {
					writeResponseHeaders()
					flushTunnelResponse(w)
				}
			case gatewayv2.TunnelFrameKind_TUNNEL_FRAME_KIND_HTTP_RESPONSE_BODY:
				if !responseStarted {
					responseStarted = true
					responseHeaders = http.Header{}
					writeResponseHeaders()
				}
				body := frame.GetBody()
				if len(body) == 0 {
					continue
				}
				if rewriteKind != tunnelResponseRewriteNone {
					if len(rewriteBuffer)+len(body) <= tunnelRewriteBodyMaxBytes {
						rewriteBuffer = append(rewriteBuffer, body...)
						continue
					}
					if !flushRewriteBuffer() {
						return
					}
				}
				writeResponseHeaders()
				if _, err := w.Write(body); err != nil {
					return
				}
				flushTunnelResponse(w)
			case gatewayv2.TunnelFrameKind_TUNNEL_FRAME_KIND_HTTP_RESPONSE_END:
				if rewriteKind != tunnelResponseRewriteNone {
					body := rewriteBuffer
					if rewritten, changed := rewriteTunnelResponseBody(body, rewrite, rewriteKind); changed {
						body = rewritten
						if rewriteKind == tunnelResponseRewriteHTML {
							amendTunnelCSP(responseHeaders, tunnelShimScriptBody(rewrite))
						}
					}
					writeResponseHeaders()
					if len(body) > 0 {
						if _, err := w.Write(body); err != nil {
							return
						}
					}
					rewriteBuffer = nil
				} else if responseStarted && !responseHeadersWritten {
					writeResponseHeaders()
				}
				completed = true
				flushTunnelResponse(w)
				return
			case gatewayv2.TunnelFrameKind_TUNNEL_FRAME_KIND_ERROR:
				if !responseStarted {
					writeTunnelError(w, http.StatusBadGateway, frame.GetError())
				} else if rewriteKind != tunnelResponseRewriteNone {
					flushRewriteBuffer()
				}
				return
			case gatewayv2.TunnelFrameKind_TUNNEL_FRAME_KIND_CANCEL:
				if !responseStarted {
					writeTunnelError(w, http.StatusServiceUnavailable, "tunnel canceled")
				} else if rewriteKind != tunnelResponseRewriteNone {
					flushRewriteBuffer()
				}
				return
			}
		}
	}
}

func serveTunnelWebSocket(
	w http.ResponseWriter,
	r *http.Request,
	sm *session.Manager,
	slug string,
	restPath string,
) {
	streamID := "w-" + uuid.NewString()
	lease, err := sm.AcquireTunnel(slug, streamID)
	if err != nil {
		writeTunnelAcquireError(w, err)
		return
	}

	if err := sm.SendTunnelFrameToAgent(lease.AgentID(), &gatewayv2.TunnelFrame{
		StreamId:  streamID,
		Kind:      gatewayv2.TunnelFrameKind_TUNNEL_FRAME_KIND_WS_DIAL,
		TargetUrl: lease.TargetURL(),
		Method:    r.Method,
		Path:      restPath,
		Headers:   tunnelWebSocketRequestHeaders(r, lease.Slug()),
	}); err != nil {
		lease.Release()
		writeTunnelAcquireError(w, err)
		return
	}

	wsSubprotocol, dialErr := awaitTunnelWebSocketDial(lease)
	if dialErr != nil {
		_ = sm.SendTunnelFrameToAgent(lease.AgentID(), &gatewayv2.TunnelFrame{
			StreamId: streamID,
			Kind:     gatewayv2.TunnelFrameKind_TUNNEL_FRAME_KIND_CANCEL,
			Error:    dialErr.Error(),
		})
		lease.Release()
		writeTunnelError(w, http.StatusBadGateway, dialErr.Error())
		return
	}

	upgrader := websocket.Upgrader{
		CheckOrigin: func(_ *http.Request) bool {
			return true
		},
	}
	if wsSubprotocol != "" {
		upgrader.Subprotocols = []string{wsSubprotocol}
	}
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		_ = sm.SendTunnelFrameToAgent(lease.AgentID(), &gatewayv2.TunnelFrame{
			StreamId:    streamID,
			Kind:        gatewayv2.TunnelFrameKind_TUNNEL_FRAME_KIND_WS_CLOSE,
			WsCloseCode: websocket.CloseGoingAway,
		})
		lease.Release()
		return
	}
	ws.SetReadLimit(tunnelDataPlaneWSReadLimit)
	defer lease.Release()
	pumpTunnelWebSocket(ws, sm, lease, streamID)
}

func pumpTunnelWebSocket(
	ws *websocket.Conn,
	sm *session.Manager,
	lease *session.TunnelStreamLease,
	streamID string,
) {
	closeSent := false
	defer func() {
		if !closeSent {
			_ = sm.SendTunnelFrameToAgent(lease.AgentID(), &gatewayv2.TunnelFrame{
				StreamId:    streamID,
				Kind:        gatewayv2.TunnelFrameKind_TUNNEL_FRAME_KIND_WS_CLOSE,
				WsCloseCode: websocket.CloseGoingAway,
			})
		}
		_ = ws.Close()
	}()

	visitorFrames := make(chan *gatewayv2.TunnelFrame, 64)
	visitorClose := make(chan *gatewayv2.TunnelFrame, 1)
	readerDone := make(chan struct{})
	go func() {
		defer close(readerDone)
		for {
			messageType, body, err := ws.ReadMessage()
			if err != nil {
				closeFrame := &gatewayv2.TunnelFrame{
					StreamId:    streamID,
					Kind:        gatewayv2.TunnelFrameKind_TUNNEL_FRAME_KIND_WS_CLOSE,
					WsCloseCode: websocket.CloseGoingAway,
				}
				var closeErr *websocket.CloseError
				if errors.As(err, &closeErr) {
					closeFrame.WsCloseCode = uint32(closeErr.Code)
					closeFrame.WsCloseReason = closeErr.Text
				}
				visitorClose <- closeFrame
				return
			}
			wireType := gatewayv2.TunnelWsMessageType_TUNNEL_WS_MESSAGE_TYPE_BINARY
			if messageType == websocket.TextMessage {
				wireType = gatewayv2.TunnelWsMessageType_TUNNEL_WS_MESSAGE_TYPE_TEXT
			}
			frame := &gatewayv2.TunnelFrame{
				StreamId:      streamID,
				Kind:          gatewayv2.TunnelFrameKind_TUNNEL_FRAME_KIND_WS_FRAME,
				Body:          body,
				WsMessageType: wireType,
			}
			select {
			case visitorFrames <- frame:
			case <-lease.Done():
				return
			}
		}
	}()

	for {
		select {
		case <-lease.Done():
			closeSent = true
			return
		case closeFrame := <-visitorClose:
			closeSent = true
			_ = sm.SendTunnelFrameToAgent(lease.AgentID(), closeFrame)
			return
		case <-readerDone:
			closeSent = true
			_ = sm.SendTunnelFrameToAgent(lease.AgentID(), &gatewayv2.TunnelFrame{
				StreamId:    streamID,
				Kind:        gatewayv2.TunnelFrameKind_TUNNEL_FRAME_KIND_WS_CLOSE,
				WsCloseCode: websocket.CloseGoingAway,
			})
			return
		case frame := <-visitorFrames:
			if frame != nil {
				_ = sm.SendTunnelFrameToAgent(lease.AgentID(), frame)
			}
		case frame := <-lease.Frames():
			if frame == nil {
				continue
			}
			switch frame.GetKind() {
			case gatewayv2.TunnelFrameKind_TUNNEL_FRAME_KIND_WS_FRAME:
				messageType := websocket.BinaryMessage
				if frame.GetWsMessageType() == gatewayv2.TunnelWsMessageType_TUNNEL_WS_MESSAGE_TYPE_TEXT {
					messageType = websocket.TextMessage
				}
				if err := ws.WriteMessage(messageType, frame.GetBody()); err != nil {
					return
				}
			case gatewayv2.TunnelFrameKind_TUNNEL_FRAME_KIND_WS_CLOSE:
				closeSent = true
				code := int(frame.GetWsCloseCode())
				if code == 0 {
					code = websocket.CloseNormalClosure
				}
				deadline := time.Now().Add(time.Second)
				_ = ws.WriteControl(
					websocket.CloseMessage,
					websocket.FormatCloseMessage(code, frame.GetWsCloseReason()),
					deadline,
				)
				return
			case gatewayv2.TunnelFrameKind_TUNNEL_FRAME_KIND_CANCEL,
				gatewayv2.TunnelFrameKind_TUNNEL_FRAME_KIND_ERROR:
				closeSent = true
				deadline := time.Now().Add(time.Second)
				_ = ws.WriteControl(
					websocket.CloseMessage,
					websocket.FormatCloseMessage(websocket.CloseInternalServerErr, ""),
					deadline,
				)
				return
			}
		}
	}
}

func awaitTunnelWebSocketDial(lease *session.TunnelStreamLease) (string, error) {
	timer := time.NewTimer(tunnelWebSocketDialTimeout)
	defer timer.Stop()
	for {
		select {
		case <-timer.C:
			return "", errors.New("local tunnel websocket dial timed out")
		case <-lease.Done():
			return "", errors.New("tunnel stream closed before websocket dial completed")
		case frame := <-lease.Frames():
			if frame == nil {
				continue
			}
			switch frame.GetKind() {
			case gatewayv2.TunnelFrameKind_TUNNEL_FRAME_KIND_WS_DIAL_OK:
				return strings.TrimSpace(frame.GetWsSubprotocol()), nil
			case gatewayv2.TunnelFrameKind_TUNNEL_FRAME_KIND_WS_DIAL_ERROR,
				gatewayv2.TunnelFrameKind_TUNNEL_FRAME_KIND_ERROR,
				gatewayv2.TunnelFrameKind_TUNNEL_FRAME_KIND_CANCEL,
				gatewayv2.TunnelFrameKind_TUNNEL_FRAME_KIND_WS_CLOSE:
				message := strings.TrimSpace(frame.GetError())
				if message == "" {
					message = "local tunnel websocket dial failed"
				}
				return "", errors.New(message)
			}
		}
	}
}

func streamTunnelHTTPRequestBody(
	ctx context.Context,
	sm *session.Manager,
	agentID string,
	streamID string,
	body io.ReadCloser,
	result chan<- error,
) {
	var resultErr error
	defer func() {
		result <- resultErr
	}()
	defer func() { _ = body.Close() }()

	buffer := make([]byte, tunnelBodyChunkSize)
	sent := 0
	for {
		n, err := body.Read(buffer)
		if n > 0 {
			sent += n
			if sent > tunnelRequestBodyMaxBytes {
				resultErr = errTunnelRequestBodyTooLarge
				_ = sm.SendTunnelFrameToAgent(agentID, &gatewayv2.TunnelFrame{
					StreamId: streamID,
					Kind:     gatewayv2.TunnelFrameKind_TUNNEL_FRAME_KIND_CANCEL,
					Error:    errTunnelRequestBodyTooLarge.Error(),
				})
				return
			}
			chunk := make([]byte, n)
			copy(chunk, buffer[:n])
			if sendErr := sm.SendTunnelFrameToAgent(agentID, &gatewayv2.TunnelFrame{
				StreamId: streamID,
				Kind:     gatewayv2.TunnelFrameKind_TUNNEL_FRAME_KIND_HTTP_REQUEST_BODY,
				Body:     chunk,
			}); sendErr != nil {
				resultErr = sendErr
				return
			}
		}
		if errors.Is(err, io.EOF) {
			_ = sm.SendTunnelFrameToAgent(agentID, &gatewayv2.TunnelFrame{
				StreamId: streamID,
				Kind:     gatewayv2.TunnelFrameKind_TUNNEL_FRAME_KIND_HTTP_REQUEST_END,
			})
			return
		}
		if err != nil {
			resultErr = err
			_ = sm.SendTunnelFrameToAgent(agentID, &gatewayv2.TunnelFrame{
				StreamId: streamID,
				Kind:     gatewayv2.TunnelFrameKind_TUNNEL_FRAME_KIND_CANCEL,
				Error:    err.Error(),
			})
			return
		}
		select {
		case <-ctx.Done():
			resultErr = ctx.Err()
			return
		default:
		}
	}
}

func parseTunnelPublicPath(rawPath string) (string, string, bool) {
	if !strings.HasPrefix(rawPath, "/t/") {
		return "", "", false
	}
	trimmed := strings.TrimPrefix(rawPath, "/t/")
	parts := strings.SplitN(trimmed, "/", 2)
	slug := strings.TrimSpace(parts[0])
	if slug == "" {
		return "", "", false
	}
	if len(parts) == 1 || parts[1] == "" {
		return slug, "/", true
	}
	return slug, "/" + parts[1], true
}

func parseTunnelPublicPathWithoutTrailingSlash(rawPath string) (string, bool) {
	if !strings.HasPrefix(rawPath, "/t/") {
		return "", false
	}
	trimmed := strings.TrimPrefix(rawPath, "/t/")
	if trimmed == "" || strings.Contains(trimmed, "/") {
		return "", false
	}
	return strings.TrimSpace(trimmed), strings.TrimSpace(trimmed) != ""
}

func writeTunnelAcquireError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, session.ErrTunnelNotFound), errors.Is(err, session.ErrTunnelExpired):
		writeTunnelError(w, http.StatusNotFound, "tunnel not found")
	case errors.Is(err, session.ErrAgentOffline):
		writeTunnelError(w, http.StatusServiceUnavailable, "agent offline")
	case errors.Is(err, session.ErrTunnelOverLimit):
		writeTunnelError(w, http.StatusTooManyRequests, "tunnel connection limit exceeded")
	default:
		writeTunnelError(w, http.StatusBadGateway, err.Error())
	}
}

func writeTunnelError(w http.ResponseWriter, status int, message string) {
	message = strings.TrimSpace(message)
	if message == "" {
		message = http.StatusText(status)
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(message))
}

func isWebSocketUpgrade(r *http.Request) bool {
	return strings.EqualFold(r.Header.Get("Upgrade"), "websocket") &&
		strings.Contains(strings.ToLower(r.Header.Get("Connection")), "upgrade")
}

func tunnelRequestHeaders(r *http.Request, slug string) []*gatewayv2.TunnelHeader {
	headers := filteredTunnelRequestHeaders(r.Header, false)
	return appendTunnelForwardedHeaders(headers, r, slug)
}

func tunnelWebSocketRequestHeaders(r *http.Request, slug string) []*gatewayv2.TunnelHeader {
	headers := filteredTunnelRequestHeaders(r.Header, true)
	return appendTunnelForwardedHeaders(headers, r, slug)
}

func filteredTunnelRequestHeaders(headers http.Header, websocketUpgrade bool) []*gatewayv2.TunnelHeader {
	out := make([]*gatewayv2.TunnelHeader, 0, len(headers))
	for name, values := range headers {
		canonical := http.CanonicalHeaderKey(strings.TrimSpace(name))
		if canonical == "" || shouldDropTunnelRequestHeader(canonical, websocketUpgrade) {
			continue
		}
		for _, value := range values {
			out = append(out, &gatewayv2.TunnelHeader{
				Name:  canonical,
				Value: value,
			})
		}
	}
	return out
}

func shouldDropTunnelRequestHeader(name string, websocketUpgrade bool) bool {
	lower := strings.ToLower(name)
	// Visitor-supplied forwarding headers are stripped so the local service
	// only ever sees the gateway's own X-Forwarded-* values.
	if strings.HasPrefix(lower, "x-forwarded-") || lower == "forwarded" {
		return true
	}
	switch lower {
	case "connection",
		"keep-alive",
		"proxy-authenticate",
		"proxy-authorization",
		"proxy-connection",
		"te",
		"trailer",
		"transfer-encoding",
		"upgrade",
		"host":
		return true
	}
	if websocketUpgrade {
		switch lower {
		case "sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions", "sec-websocket-accept":
			return true
		}
	}
	return false
}

func shouldDropTunnelResponseHeader(name string) bool {
	switch strings.ToLower(name) {
	case "connection",
		"keep-alive",
		"proxy-authenticate",
		"proxy-authorization",
		"proxy-connection",
		"te",
		"trailer",
		"transfer-encoding",
		"upgrade":
		return true
	default:
		return false
	}
}

func appendTunnelForwardedHeaders(
	headers []*gatewayv2.TunnelHeader,
	r *http.Request,
	slug string,
) []*gatewayv2.TunnelHeader {
	if r == nil {
		return headers
	}
	proto := "http"
	if r.TLS != nil {
		proto = "https"
	}
	headers = append(headers,
		&gatewayv2.TunnelHeader{Name: "X-Forwarded-Host", Value: r.Host},
		&gatewayv2.TunnelHeader{Name: "X-Forwarded-Proto", Value: proto},
	)
	if origin := strings.TrimSpace(r.Header.Get("Origin")); origin != "" {
		headers = append(headers, &gatewayv2.TunnelHeader{Name: "X-Forwarded-Origin", Value: origin})
	}
	if slug = strings.TrimSpace(slug); slug != "" {
		headers = append(headers, &gatewayv2.TunnelHeader{Name: "X-Forwarded-Prefix", Value: "/t/" + slug})
	}
	return headers
}

func tunnelResponseHeaders(frame *gatewayv2.TunnelFrame, rw tunnelRewrite) http.Header {
	headers := http.Header{}
	for _, header := range frame.GetHeaders() {
		name := http.CanonicalHeaderKey(strings.TrimSpace(header.GetName()))
		if name == "" || shouldDropTunnelResponseHeader(name) {
			continue
		}
		value := header.GetValue()
		if strings.EqualFold(name, "Location") {
			value = rewriteTunnelLocation(value, rw)
		}
		if strings.EqualFold(name, "Set-Cookie") {
			value = rewriteTunnelSetCookiePath(value, rw)
		}
		headers.Add(name, value)
	}
	return headers
}

func writeTunnelHTTPHeaders(w http.ResponseWriter, headers http.Header) {
	for name, values := range headers {
		for _, value := range values {
			w.Header().Add(name, value)
		}
	}
}

func flushTunnelResponse(w http.ResponseWriter) {
	if flusher, ok := w.(http.Flusher); ok {
		flusher.Flush()
	}
}

func rewriteTunnelLocation(value string, rw tunnelRewrite) string {
	publicPrefix := rw.publicPrefix()
	if publicPrefix == "" {
		return value
	}
	target, err := rw.parseTarget()
	if err != nil || target.Host == "" {
		return value
	}
	parsed, err := url.Parse(value)
	if err != nil {
		return value
	}
	if parsed.IsAbs() {
		if !strings.EqualFold(parsed.Scheme, target.Scheme) || !strings.EqualFold(parsed.Host, target.Host) {
			return value
		}
		path := stripTunnelTargetBasePath(parsed.EscapedPath(), target.EscapedPath())
		return publicPrefix + appendTunnelURLQueryAndFragment(pathOrRoot(path), parsed)
	}
	if strings.HasPrefix(value, "/") {
		path := stripTunnelTargetBasePath(parsed.EscapedPath(), target.EscapedPath())
		return publicPrefix + appendTunnelURLQueryAndFragment(pathOrRoot(path), parsed)
	}
	return value
}

func rewriteTunnelSetCookiePath(value string, rw tunnelRewrite) string {
	slug := strings.TrimSpace(rw.slug)
	if slug == "" {
		return value
	}
	parts := strings.Split(value, ";")
	targetBasePath := "/"
	if target, err := rw.parseTarget(); err == nil {
		targetBasePath = target.EscapedPath()
	}
	for index, part := range parts {
		trimmed := strings.TrimSpace(part)
		if !strings.HasPrefix(strings.ToLower(trimmed), "path=") {
			continue
		}
		cookiePath := strings.TrimSpace(trimmed[len("path="):])
		if cookiePath == "" {
			cookiePath = "/"
		}
		rest := stripTunnelTargetBasePath(cookiePath, targetBasePath)
		if rest == "" {
			rest = "/"
		}
		prefix := ""
		if leading := len(part) - len(strings.TrimLeft(part, " \t")); leading > 0 {
			prefix = part[:leading]
		}
		parts[index] = fmt.Sprintf("%sPath=/t/%s%s", prefix, slug, rest)
	}
	return strings.Join(parts, ";")
}

func stripTunnelTargetBasePath(pathValue string, basePath string) string {
	pathValue = normalizeTunnelPath(pathValue)
	basePath = normalizeTunnelPath(basePath)
	if basePath == "/" {
		return pathValue
	}
	if pathValue == basePath {
		return "/"
	}
	if strings.HasPrefix(pathValue, strings.TrimRight(basePath, "/")+"/") {
		return strings.TrimPrefix(pathValue, strings.TrimRight(basePath, "/"))
	}
	return pathValue
}

func normalizeTunnelPath(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return "/"
	}
	if !strings.HasPrefix(value, "/") {
		value = "/" + value
	}
	return value
}
