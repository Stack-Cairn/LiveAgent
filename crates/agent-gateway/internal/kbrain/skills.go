package kbrain

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

func gatewaySkillSettings(raw json.RawMessage) (json.RawMessage, error) {
	var settings struct {
		Enabled  *bool    `json:"enabled"`
		Selected []string `json:"selected"`
	}
	if err := json.Unmarshal(raw, &settings); err != nil || settings.Enabled == nil || settings.Selected == nil {
		return nil, errors.New("skills settings require enabled and selected")
	}
	return json.Marshal(settings)
}

// SkillManage uses fixed resource routes; skill execution stays in K-brain.
func (r *Relay) SkillManage(ctx context.Context, request *gatewayv2.SkillManageRequest) (*gatewayv2.SkillManageResponse, error) {
	if request == nil {
		return nil, errors.New("skill manage request is required")
	}
	var input map[string]json.RawMessage
	if err := json.Unmarshal([]byte(request.GetPayloadJson()), &input); err != nil || input == nil {
		return nil, errors.New("skill payload must be an object")
	}
	var action string
	if err := json.Unmarshal(input["action"], &action); err != nil || action == "" {
		return nil, errors.New("skill action is required")
	}
	method, path := http.MethodPost, "/v1/skills/manage"
	var body any = input
	switch action {
	case "list":
		var workdir string
		if raw, ok := input["workdir"]; ok {
			if err := json.Unmarshal(raw, &workdir); err != nil {
				return nil, errors.New("skill workdir must be a string")
			}
		}
		method, path, body = http.MethodGet, "/v1/skills?workdir="+url.QueryEscape(workdir), nil
	case "settings":
		delete(input, "action")
		method, path = http.MethodPut, "/v1/skills/settings"
	}
	var result json.RawMessage
	response, err := r.client.request(ctx, method, path, body, &result)
	if err != nil {
		return nil, err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("kbrain skills: %s: %s", response.Status, result)
	}
	return &gatewayv2.SkillManageResponse{ResultJson: string(result)}, nil
}
