package server

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/liveagent/agent-gateway/internal/handler"
	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
)

func (c *websocketConnection) handleProviderList(req websocketRequest) {
	response, err := c.awaitAgentResponse(req.ID, &gatewayv1.GatewayEnvelope{
		RequestId: req.ID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_ProviderList{
			ProviderList: &gatewayv1.ProviderListRequest{},
		},
	})
	if err != nil {
		_ = c.writeError(req.ID, websocketErrorMessage(err))
		return
	}
	if errResp := response.GetError(); errResp != nil {
		_ = c.writeError(req.ID, errResp.GetMessage())
		return
	}

	resp := response.GetProviderListResp()
	if resp == nil {
		_ = c.writeError(req.ID, "unexpected agent response")
		return
	}

	var payload any
	raw := strings.TrimSpace(resp.GetProvidersJson())
	if raw == "" {
		payload = []any{}
	} else if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		_ = c.writeError(req.ID, "provider list response is not valid JSON")
		return
	}

	_ = c.writeResponse(req.ID, payload)
}

func (c *websocketConnection) handleProviderModels(req websocketRequest) {
	var body handler.ProviderModelsRequestBody
	if err := decodeWebSocketPayload(req.Payload, &body); err != nil {
		_ = c.writeError(req.ID, "invalid provider.models payload")
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), c.cfg.RequestTimeout)
	defer cancel()

	result, err := handler.FetchProviderModels(ctx, body)
	if err != nil {
		var statusErr *handler.HTTPStatusError
		if errors.As(err, &statusErr) {
			if statusErr.Code != "" {
				_ = c.writeErrorCode(req.ID, statusErr.Message, statusErr.Code)
			} else {
				_ = c.writeError(req.ID, statusErr.Message)
			}
			return
		}
		_ = c.writeError(req.ID, websocketErrorMessage(err))
		return
	}

	var payload any
	if err := json.Unmarshal(result.Body, &payload); err != nil {
		_ = c.writeError(req.ID, "provider model response is not valid JSON")
		return
	}

	_ = c.writeResponse(req.ID, payload)
}
