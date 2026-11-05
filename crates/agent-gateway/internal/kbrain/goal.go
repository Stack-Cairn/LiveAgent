package kbrain

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

// goalState is the subset of K-brain's GoalState the WebUI goal bar shows.
type goalState struct {
	Goal      string `json:"goal"`
	Status    string `json:"status"`
	Round     int32  `json:"round"`
	MaxRounds int32  `json:"max_rounds"`
	Reason    string `json:"reason"`
	StartedAt string `json:"started_at"`
}

// GoalManage serves the goal bar's non-run actions on a direct target: read the
// goal, pause it, edit its text or clear it. Set and resume start a run and stay
// unavailable here, so this never creates a session; the response names the
// Gateway conversation, not the backend session.
func (r *Relay) GoalManage(ctx context.Context, req *gatewayv2.GoalManageRequest) (*gatewayv2.GoalManageResponse, error) {
	conversationID := strings.TrimSpace(req.GetConversationId())
	if conversationID == "" {
		return nil, errors.New("conversation is unavailable")
	}
	path := "/v1/sessions/" + url.PathEscape(r.backendSessionID(conversationID)) + "/goal"
	var state goalState
	switch action := strings.TrimSpace(req.GetAction()); action {
	case "get":
		if err := r.commandResource(ctx, http.MethodGet, path, nil, &state); err != nil {
			return nil, err
		}
	case "pause", "clear":
		if err := r.commandResource(ctx, http.MethodPost, path, map[string]string{"action": action}, &state); err != nil {
			return nil, err
		}
	case "update":
		goal := strings.TrimSpace(req.GetGoal())
		if goal == "" {
			return nil, errors.New("goal text is required for goal update")
		}
		if err := r.commandResource(ctx, http.MethodPost, path, map[string]string{"action": action, "goal": goal}, &state); err != nil {
			return nil, err
		}
	default:
		return nil, errors.New("goal action must be get, pause, update or clear")
	}
	return &gatewayv2.GoalManageResponse{
		ConversationId: conversationID, Goal: state.Goal, Status: state.Status, Round: state.Round,
		MaxRounds: state.MaxRounds, Reason: state.Reason, StartedAt: state.StartedAt,
	}, nil
}
