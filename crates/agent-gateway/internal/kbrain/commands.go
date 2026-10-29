package kbrain

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

// SlashCommands keeps project trust and Markdown command discovery in K-brain.
func (r *Relay) SlashCommands(ctx context.Context, req *gatewayv2.SlashCommandListRequest) (*gatewayv2.SlashCommandListResponse, error) {
	if req == nil {
		return nil, errors.New("slash command list request is required")
	}
	var document struct {
		Commands []struct {
			Name         string `json:"name"`
			Description  string `json:"description"`
			ArgumentHint string `json:"argument_hint"`
			Kind         string `json:"kind"`
			Source       string `json:"source"`
		} `json:"commands"`
	}
	if err := r.commandResource(ctx, http.MethodGet, "/v1/commands?workdir="+url.QueryEscape(req.GetWorkdir()), nil, &document); err != nil {
		return nil, err
	}
	out := &gatewayv2.SlashCommandListResponse{}
	for _, command := range document.Commands {
		// Direct targets do not implement the desktop goal workflow.
		if command.Name == "goal" && command.Kind == "action" {
			continue
		}
		out.Commands = append(out.Commands, &gatewayv2.SlashCommandSummary{
			Name: command.Name, Description: command.Description, ArgumentHint: command.ArgumentHint,
			Kind: command.Kind, Source: command.Source,
		})
	}
	return out, nil
}

// Loops never creates a session: the backend validates the existing conversation.
func (r *Relay) Loops(ctx context.Context, req *gatewayv2.LoopManageRequest) (*gatewayv2.LoopManageResponse, error) {
	if req == nil || strings.TrimSpace(req.GetConversationId()) == "" {
		return nil, errors.New("conversation is unavailable")
	}
	path := "/v1/sessions/" + url.PathEscape(r.backendSessionID(strings.TrimSpace(req.GetConversationId()))) + "/loops"
	var result struct {
		Loops []*gatewayv2.LoopSummary `json:"loops"`
	}
	switch req.GetAction() {
	case "list":
		if err := r.commandResource(ctx, http.MethodGet, path, nil, &result); err != nil {
			return nil, err
		}
	case "create":
		if err := r.client.requireHandshake(ctx, ""); err != nil {
			return nil, err
		}
		var loop gatewayv2.LoopSummary
		input := map[string]string{"cron": req.GetCron(), "interval": req.GetInterval(), "prompt": req.GetPrompt(), "reasoning": req.GetReasoning()}
		if err := r.commandResource(ctx, http.MethodPost, path, input, &loop); err != nil {
			return nil, err
		}
		result.Loops = []*gatewayv2.LoopSummary{&loop}
	case "cancel":
		if strings.TrimSpace(req.GetLoopId()) == "" {
			return nil, errors.New("loop id is required")
		}
		var cancelled struct {
			OK bool `json:"ok"`
		}
		if err := r.commandResource(ctx, http.MethodDelete, path+"/"+url.PathEscape(req.GetLoopId()), nil, &cancelled); err != nil {
			return nil, err
		}
		if !cancelled.OK {
			return nil, errors.New("kbrain did not confirm loop cancellation")
		}
	default:
		return nil, errors.New("loop action must be create, list or cancel")
	}
	return &gatewayv2.LoopManageResponse{Loops: result.Loops}, nil
}

func (r *Relay) commandResource(ctx context.Context, method, path string, input, output any) error {
	var raw json.RawMessage
	response, err := r.client.request(ctx, method, path, input, &raw)
	if err != nil {
		return err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("kbrain command: %s: %s", response.Status, raw)
	}
	return json.Unmarshal(raw, output)
}
