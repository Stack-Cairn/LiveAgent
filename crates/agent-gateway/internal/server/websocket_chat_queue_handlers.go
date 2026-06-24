package server

import (
	"strings"
	"time"

	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
)

type websocketChatQueueRequestPayload struct {
	ConversationID    string `json:"conversation_id"`
	ItemID            string `json:"item_id"`
	Direction         string `json:"direction"`
	Revision          uint64 `json:"revision"`
	DraftJSON         string `json:"draft_json"`
	UploadedFilesJSON string `json:"uploaded_files_json"`
	RequestJSON       string `json:"request_json"`
}

func chatQueueActionFromRequestType(requestType string) string {
	return strings.TrimPrefix(strings.TrimSpace(requestType), "chat_queue.")
}

func (c *websocketConnection) handleChatQueueRequest(req websocketRequest) {
	var body websocketChatQueueRequestPayload
	if err := decodeWebSocketPayload(req.Payload, &body); err != nil {
		_ = c.writeError(req.ID, "invalid "+req.Type+" payload")
		return
	}
	if !c.sm.IsOnline() {
		_ = c.writeError(req.ID, "agent offline")
		return
	}

	response, err := c.awaitAgentResponse(req.ID, &gatewayv1.GatewayEnvelope{
		RequestId: req.ID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_ChatQueue{
			ChatQueue: &gatewayv1.ChatQueueRequest{
				Action:            chatQueueActionFromRequestType(req.Type),
				ConversationId:    strings.TrimSpace(body.ConversationID),
				ItemId:            strings.TrimSpace(body.ItemID),
				Direction:         strings.TrimSpace(body.Direction),
				Revision:          body.Revision,
				DraftJson:         strings.TrimSpace(body.DraftJSON),
				UploadedFilesJson: strings.TrimSpace(body.UploadedFilesJSON),
				RequestJson:       strings.TrimSpace(body.RequestJSON),
			},
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

	resp := response.GetChatQueueResp()
	if resp == nil {
		_ = c.writeError(req.ID, "unexpected agent response")
		return
	}

	_ = c.writeResponse(req.ID, map[string]any{
		"accepted":      resp.GetAccepted(),
		"message":       resp.GetMessage(),
		"snapshot_json": resp.GetSnapshotJson(),
		"item_json":     resp.GetItemJson(),
		"error_code":    resp.GetErrorCode(),
		"revision":      resp.GetRevision(),
	})
}
