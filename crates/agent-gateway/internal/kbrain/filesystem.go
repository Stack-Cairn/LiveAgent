package kbrain

import (
	"context"
	"encoding/json"
	"errors"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"google.golang.org/protobuf/proto"
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
	case request.GetFsReadWorkspaceImage() != nil:
		req := request.GetFsReadWorkspaceImage()
		input = map[string]any{"action": "read_preview", "workdir": req.GetWorkdir(), "path": req.GetPath()}
		response := &gatewayv2.FsReadWorkspaceImageResponse{}
		output, envelope.Payload = response, &gatewayv2.AgentEnvelope_FsReadWorkspaceImageResp{FsReadWorkspaceImageResp: response}
	case request.GetFsWriteText() != nil:
		req := request.GetFsWriteText()
		body := map[string]any{"action": "write_text", "workdir": req.GetWorkdir(), "path": req.GetPath(), "content": req.GetContent(), "mode": req.GetMode()}
		if req.GetHasExpectedMtimeMs() {
			body["expected_mtime_ms"] = req.GetExpectedMtimeMs()
		}
		if req.GetHasExpectedContentHash() {
			body["expected_content_hash"] = req.GetExpectedContentHash()
		}
		input = body
		response := &gatewayv2.FsWriteTextResponse{}
		output, envelope.Payload = response, &gatewayv2.AgentEnvelope_FsWriteTextResp{FsWriteTextResp: response}
	case request.GetFsCreateDir() != nil:
		req := request.GetFsCreateDir()
		input = map[string]any{"action": "mkdir", "workdir": req.GetWorkdir(), "path": req.GetPath()}
		response := &gatewayv2.FsCreateDirResponse{}
		output, envelope.Payload = response, &gatewayv2.AgentEnvelope_FsCreateDirResp{FsCreateDirResp: response}
	case request.GetFsRename() != nil:
		req := request.GetFsRename()
		input = map[string]any{"action": "rename", "workdir": req.GetWorkdir(), "path": req.GetFromPath(), "to_path": req.GetToPath()}
		response := &gatewayv2.FsRenameResponse{}
		output, envelope.Payload = response, &gatewayv2.AgentEnvelope_FsRenameResp{FsRenameResp: response}
	case request.GetFsDelete() != nil:
		req := request.GetFsDelete()
		input = map[string]any{"action": "delete", "workdir": req.GetWorkdir(), "path": req.GetPath()}
		response := &gatewayv2.FsDeleteResponse{}
		output, envelope.Payload = response, &gatewayv2.AgentEnvelope_FsDeleteResp{FsDeleteResp: response}
	default:
		return nil, false, nil
	}
	if proto.Size(request) > 3<<20 {
		return nil, true, errors.New("filesystem request exceeds size limit")
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
