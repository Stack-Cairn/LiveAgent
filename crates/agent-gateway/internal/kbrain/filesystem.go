package kbrain

import (
	"context"
	"encoding/json"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

// Filesystem maps only known UI resource operations; execution stays in K-brain.
func (r *Relay) Filesystem(ctx context.Context, request *gatewayv2.GatewayEnvelope) (*gatewayv2.AgentEnvelope, bool, error) {
	var input any
	var output any
	envelope := &gatewayv2.AgentEnvelope{}
	switch {
	case request.GetFsRoots() != nil:
		input = map[string]any{"action": "roots"}
		response := &gatewayv2.FsRootsResponse{}
		output, envelope.Payload = response, &gatewayv2.AgentEnvelope_FsRootsResp{FsRootsResp: response}
	case request.GetFsListDirs() != nil:
		req := request.GetFsListDirs()
		input = map[string]any{"action": "list_dirs", "path": req.GetPath(), "max_results": req.GetMaxResults()}
		response := &gatewayv2.FsListDirsResponse{}
		output, envelope.Payload = response, &gatewayv2.AgentEnvelope_FsListDirsResp{FsListDirsResp: response}
	case request.GetFsList() != nil:
		req := request.GetFsList()
		input = map[string]any{"action": "list", "workdir": req.GetWorkdir(), "path": req.GetPath(), "depth": req.GetDepth(), "offset": req.GetOffset(), "max_results": req.GetMaxResults(), "show_hidden": req.GetShowHidden()}
		response := &gatewayv2.FsListResponse{}
		output, envelope.Payload = response, &gatewayv2.AgentEnvelope_FsListResp{FsListResp: response}
	case request.GetFsReadEditableText() != nil:
		req := request.GetFsReadEditableText()
		input = map[string]any{"action": "read_text", "workdir": req.GetWorkdir(), "path": req.GetPath()}
		response := &gatewayv2.FsReadEditableTextResponse{}
		output, envelope.Payload = response, &gatewayv2.AgentEnvelope_FsReadEditableTextResp{FsReadEditableTextResp: response}
	default:
		return nil, false, nil
	}
	var raw json.RawMessage
	if err := r.commandResource(ctx, "POST", "/v1/fs", input, &raw); err != nil {
		return nil, true, err
	}
	if err := json.Unmarshal(raw, output); err != nil {
		return nil, true, err
	}
	return envelope, true, nil
}
