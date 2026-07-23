package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/google/uuid"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/session"
)

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]any{
		"error": message,
	})
}

func newRequestID() string {
	return uuid.NewString()
}

func waitForEnvelope(
	ctx context.Context,
	ch <-chan *gatewayv2.AgentEnvelope,
	done <-chan struct{},
) (*gatewayv2.AgentEnvelope, error) {
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-done:
		return nil, session.ErrAgentOffline
	case env, ok := <-ch:
		if !ok {
			return nil, session.ErrAgentOffline
		}
		return env, nil
	}
}

func GatewayErrorStatus(errResp *gatewayv2.ErrorResponse) int {
	if errResp == nil {
		return http.StatusBadGateway
	}
	switch int(errResp.GetCode()) {
	case http.StatusBadRequest, http.StatusUnauthorized, http.StatusForbidden, http.StatusNotFound, http.StatusConflict:
		return int(errResp.GetCode())
	default:
		return http.StatusBadGateway
	}
}

func errorMessage(err error, fallback string) string {
	if err == nil {
		return fallback
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "request timed out"
	}
	if errors.Is(err, context.Canceled) {
		return "request canceled"
	}
	if errors.Is(err, session.ErrAgentOffline) {
		return "agent offline"
	}
	return err.Error()
}
