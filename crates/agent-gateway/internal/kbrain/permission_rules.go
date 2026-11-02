package kbrain

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

// permissionRulesInput is everything the settings page may send; other fields
// (session_id, unknown keys) are dropped before K-brain sees the request.
type permissionRulesInput struct {
	Workspace string `json:"workspace"`
	Rule      string `json:"rule"`
	Effect    string `json:"effect"`
	Scope     string `json:"scope"`
	ID        string `json:"id"`
}

// PermissionRules serves Settings → Permissions for a direct K-brain target: list,
// add and delete remembered rules through /v1/permissions/rules. Session rules stay
// with their session and are not reachable here.
func (r *Relay) PermissionRules(ctx context.Context, req *gatewayv2.PermissionRulesRequest) (*gatewayv2.PermissionRulesResponse, error) {
	if req == nil {
		return nil, errors.New("invalid permission rules request")
	}
	var in permissionRulesInput
	if raw := strings.TrimSpace(req.GetInputJson()); raw != "" {
		if err := json.Unmarshal([]byte(raw), &in); err != nil {
			return nil, errors.New("invalid permission rules request: input must be a JSON object")
		}
	}
	workspace := strings.TrimSpace(in.Workspace)
	in.Effect, in.Scope = strings.TrimSpace(in.Effect), strings.TrimSpace(in.Scope)
	const path = "/v1/permissions/rules"
	var (
		method string
		target string
		body   any
	)
	switch strings.TrimSpace(req.GetAction()) {
	case "list":
		method, target = http.MethodGet, path+permissionRulesQuery("workspace", workspace)
	case "add":
		rule := strings.TrimSpace(in.Rule)
		if rule == "" {
			return nil, errors.New("invalid permission rules request: rule is required")
		}
		if in.Effect != "allow" && in.Effect != "deny" {
			return nil, errors.New("invalid permission rules request: effect must be allow or deny")
		}
		if err := checkPermissionRuleScope(in.Scope, workspace); err != nil {
			return nil, err
		}
		create := map[string]string{"rule": rule, "effect": in.Effect, "scope": in.Scope}
		if in.Scope == "project" {
			create["workspace"] = workspace
		}
		method, target, body = http.MethodPost, path, create
	case "delete":
		id := strings.TrimSpace(in.ID)
		if id == "" {
			return nil, errors.New("invalid permission rules request: id is required")
		}
		if err := checkPermissionRuleScope(in.Scope, workspace); err != nil {
			return nil, err
		}
		query := permissionRulesQuery("scope", in.Scope)
		if in.Scope == "project" {
			query += "&workspace=" + url.QueryEscape(workspace)
		}
		method, target = http.MethodDelete, path+"/"+url.PathEscape(id)+query
	default:
		return nil, errors.New("invalid permission rules request: action must be list, add or delete")
	}
	raw, err := r.permissionRulesRequest(ctx, method, target, body)
	if err != nil {
		return nil, err
	}
	return &gatewayv2.PermissionRulesResponse{ResultJson: string(raw)}, nil
}

func checkPermissionRuleScope(scope, workspace string) error {
	switch scope {
	case "user":
		return nil
	case "project":
		if workspace == "" {
			return errors.New("invalid permission rules request: project scope needs a workspace")
		}
		return nil
	}
	return errors.New("invalid permission rules request: scope must be project or user")
}

func permissionRulesQuery(key, value string) string {
	if value == "" {
		return ""
	}
	return "?" + key + "=" + url.QueryEscape(value)
}

// permissionRulesRequest returns K-brain's JSON answer; a refusal comes back as
// K-brain's own explanation, which the settings page shows as is.
func (r *Relay) permissionRulesRequest(ctx context.Context, method, path string, input any) (json.RawMessage, error) {
	resp, err := r.client.request(ctx, method, path, input, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	const maxAnswer = 4 << 20
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxAnswer+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxAnswer {
		return nil, errors.New("kbrain permission rules response is too large")
	}
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		var failure struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(data, &failure) == nil && strings.TrimSpace(failure.Error) != "" {
			return nil, errors.New(strings.TrimSpace(failure.Error))
		}
		return nil, fmt.Errorf("kbrain permission rules request: %s", resp.Status)
	}
	if !json.Valid(data) {
		return nil, errors.New("kbrain permission rules response is not JSON")
	}
	return data, nil
}
