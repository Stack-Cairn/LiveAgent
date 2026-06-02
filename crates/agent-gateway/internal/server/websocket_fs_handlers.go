package server

import (
	"strings"
	"time"

	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
)

func (c *websocketConnection) handleFsRoots(req websocketRequest) {
	// Payload is intentionally empty; we still decode to reject unexpected fields.
	var body struct{}
	if err := decodeWebSocketPayload(req.Payload, &body); err != nil {
		_ = c.writeError(req.ID, "invalid fs.roots payload")
		return
	}

	response, err := c.awaitAgentResponse(req.ID, &gatewayv1.GatewayEnvelope{
		RequestId: req.ID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_FsRoots{
			FsRoots: &gatewayv1.FsRootsRequest{},
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

	resp := response.GetFsRootsResp()
	if resp == nil {
		_ = c.writeError(req.ID, "unexpected agent response")
		return
	}

	rootPayload := make([]map[string]any, 0, len(resp.GetRoots()))
	for _, root := range resp.GetRoots() {
		rootPayload = append(rootPayload, map[string]any{
			"id":    root.GetId(),
			"path":  root.GetPath(),
			"kind":  root.GetKind(),
			"label": root.GetLabel(),
		})
	}

	_ = c.writeResponse(req.ID, map[string]any{
		"roots": rootPayload,
	})
}

func (c *websocketConnection) handleFsListDirs(req websocketRequest) {
	type payload struct {
		Path       string `json:"path"`
		MaxResults *int   `json:"max_results"`
	}

	var body payload
	if err := decodeWebSocketPayload(req.Payload, &body); err != nil {
		_ = c.writeError(req.ID, "invalid fs.list_dirs payload")
		return
	}

	dir := strings.TrimSpace(body.Path)
	if dir == "" {
		_ = c.writeError(req.ID, "path is required")
		return
	}

	maxResults, err := websocketOptionalUint32(body.MaxResults, "max_results")
	if err != nil {
		_ = c.writeError(req.ID, err.Error())
		return
	}

	response, err := c.awaitAgentResponse(req.ID, &gatewayv1.GatewayEnvelope{
		RequestId: req.ID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_FsListDirs{
			FsListDirs: &gatewayv1.FsListDirsRequest{
				Path:       dir,
				MaxResults: maxResults,
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

	resp := response.GetFsListDirsResp()
	if resp == nil {
		_ = c.writeError(req.ID, "unexpected agent response")
		return
	}

	entryPayload := make([]map[string]any, 0, len(resp.GetEntries()))
	for _, entry := range resp.GetEntries() {
		entryPayload = append(entryPayload, map[string]any{
			"path": entry.GetPath(),
			"name": entry.GetName(),
		})
	}

	_ = c.writeResponse(req.ID, map[string]any{
		"path":      strings.TrimSpace(resp.GetPath()),
		"entries":   entryPayload,
		"truncated": resp.GetTruncated(),
	})
}

func (c *websocketConnection) handleFsCreateProjectFolder(req websocketRequest) {
	type payload struct {
		Parent string `json:"parent"`
		Name   string `json:"name"`
	}

	var body payload
	if err := decodeWebSocketPayload(req.Payload, &body); err != nil {
		_ = c.writeError(req.ID, "invalid fs.create_project_folder payload")
		return
	}

	parent := strings.TrimSpace(body.Parent)
	name := strings.TrimSpace(body.Name)
	if parent == "" {
		_ = c.writeError(req.ID, "parent is required")
		return
	}
	if name == "" {
		_ = c.writeError(req.ID, "name is required")
		return
	}

	response, err := c.awaitAgentResponse(req.ID, &gatewayv1.GatewayEnvelope{
		RequestId: req.ID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_FsCreateProjectFolder{
			FsCreateProjectFolder: &gatewayv1.FsCreateProjectFolderRequest{
				Parent: parent,
				Name:   name,
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

	resp := response.GetFsCreateProjectFolderResp()
	if resp == nil {
		_ = c.writeError(req.ID, "unexpected agent response")
		return
	}

	_ = c.writeResponse(req.ID, map[string]any{
		"path": strings.TrimSpace(resp.GetPath()),
	})
}

func (c *websocketConnection) handleFsList(req websocketRequest) {
	type payload struct {
		Workdir    string `json:"workdir"`
		Path       string `json:"path"`
		Depth      *int   `json:"depth"`
		Offset     *int   `json:"offset"`
		MaxResults *int   `json:"max_results"`
	}

	var body payload
	if err := decodeWebSocketPayload(req.Payload, &body); err != nil {
		_ = c.writeError(req.ID, "invalid fs.list payload")
		return
	}

	workdir := strings.TrimSpace(body.Workdir)
	if workdir == "" {
		_ = c.writeError(req.ID, "workdir is required")
		return
	}

	depth, err := websocketOptionalUint32(body.Depth, "depth")
	if err != nil {
		_ = c.writeError(req.ID, err.Error())
		return
	}
	offset, err := websocketOptionalUint32(body.Offset, "offset")
	if err != nil {
		_ = c.writeError(req.ID, err.Error())
		return
	}
	maxResults, err := websocketOptionalUint32(body.MaxResults, "max_results")
	if err != nil {
		_ = c.writeError(req.ID, err.Error())
		return
	}

	response, err := c.awaitAgentResponse(req.ID, &gatewayv1.GatewayEnvelope{
		RequestId: req.ID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_FsList{
			FsList: &gatewayv1.FsListRequest{
				Workdir:    workdir,
				Path:       strings.TrimSpace(body.Path),
				Depth:      depth,
				Offset:     offset,
				MaxResults: maxResults,
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

	resp := response.GetFsListResp()
	if resp == nil {
		_ = c.writeError(req.ID, "unexpected agent response")
		return
	}

	_ = c.writeResponse(req.ID, websocketFsListResponsePayload(resp))
}

func (c *websocketConnection) handleFsReadEditableText(req websocketRequest) {
	type payload struct {
		Workdir string `json:"workdir"`
		Path    string `json:"path"`
	}

	var body payload
	if err := decodeWebSocketPayload(req.Payload, &body); err != nil {
		_ = c.writeError(req.ID, "invalid fs.read_editable_text payload")
		return
	}

	workdir := strings.TrimSpace(body.Workdir)
	path := strings.TrimSpace(body.Path)
	if workdir == "" {
		_ = c.writeError(req.ID, "workdir is required")
		return
	}
	if path == "" {
		_ = c.writeError(req.ID, "path is required")
		return
	}

	response, err := c.awaitAgentResponse(req.ID, &gatewayv1.GatewayEnvelope{
		RequestId: req.ID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_FsReadEditableText{
			FsReadEditableText: &gatewayv1.FsReadEditableTextRequest{
				Workdir: workdir,
				Path:    path,
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

	resp := response.GetFsReadEditableTextResp()
	if resp == nil {
		_ = c.writeError(req.ID, "unexpected agent response")
		return
	}

	_ = c.writeResponse(req.ID, websocketFsReadEditableTextResponsePayload(resp))
}

func (c *websocketConnection) handleFsReadWorkspaceImage(req websocketRequest) {
	type payload struct {
		Workdir string `json:"workdir"`
		Path    string `json:"path"`
	}

	var body payload
	if err := decodeWebSocketPayload(req.Payload, &body); err != nil {
		_ = c.writeError(req.ID, "invalid fs.read_workspace_image payload")
		return
	}

	workdir := strings.TrimSpace(body.Workdir)
	path := strings.TrimSpace(body.Path)
	if workdir == "" {
		_ = c.writeError(req.ID, "workdir is required")
		return
	}
	if path == "" {
		_ = c.writeError(req.ID, "path is required")
		return
	}

	response, err := c.awaitAgentResponse(req.ID, &gatewayv1.GatewayEnvelope{
		RequestId: req.ID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_FsReadWorkspaceImage{
			FsReadWorkspaceImage: &gatewayv1.FsReadWorkspaceImageRequest{
				Workdir: workdir,
				Path:    path,
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

	resp := response.GetFsReadWorkspaceImageResp()
	if resp == nil {
		_ = c.writeError(req.ID, "unexpected agent response")
		return
	}

	_ = c.writeResponse(req.ID, websocketFsReadWorkspaceImageResponsePayload(resp))
}

func (c *websocketConnection) handleFsWriteText(req websocketRequest) {
	type payload struct {
		Workdir             string  `json:"workdir"`
		Path                string  `json:"path"`
		Content             string  `json:"content"`
		Mode                string  `json:"mode"`
		ExpectedMtimeMs     *uint64 `json:"expected_mtime_ms"`
		ExpectedContentHash *string `json:"expected_content_hash"`
	}

	var body payload
	if err := decodeWebSocketPayload(req.Payload, &body); err != nil {
		_ = c.writeError(req.ID, "invalid fs.write_text payload")
		return
	}

	workdir := strings.TrimSpace(body.Workdir)
	path := strings.TrimSpace(body.Path)
	if workdir == "" {
		_ = c.writeError(req.ID, "workdir is required")
		return
	}
	if path == "" {
		_ = c.writeError(req.ID, "path is required")
		return
	}
	mode := strings.TrimSpace(body.Mode)
	if mode == "" {
		mode = "rewrite"
	}
	expectedHash := ""
	hasExpectedHash := false
	if body.ExpectedContentHash != nil {
		expectedHash = strings.TrimSpace(*body.ExpectedContentHash)
		hasExpectedHash = true
	}
	expectedMtime := uint64(0)
	hasExpectedMtime := false
	if body.ExpectedMtimeMs != nil {
		expectedMtime = *body.ExpectedMtimeMs
		hasExpectedMtime = true
	}

	response, err := c.awaitAgentResponse(req.ID, &gatewayv1.GatewayEnvelope{
		RequestId: req.ID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_FsWriteText{
			FsWriteText: &gatewayv1.FsWriteTextRequest{
				Workdir:                workdir,
				Path:                   path,
				Content:                body.Content,
				Mode:                   mode,
				ExpectedMtimeMs:        expectedMtime,
				ExpectedContentHash:    expectedHash,
				HasExpectedMtimeMs:     hasExpectedMtime,
				HasExpectedContentHash: hasExpectedHash,
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

	resp := response.GetFsWriteTextResp()
	if resp == nil {
		_ = c.writeError(req.ID, "unexpected agent response")
		return
	}

	_ = c.writeResponse(req.ID, websocketFsWriteTextResponsePayload(resp))
}

func (c *websocketConnection) handleFsCreateDir(req websocketRequest) {
	type payload struct {
		Workdir string `json:"workdir"`
		Path    string `json:"path"`
	}

	var body payload
	if err := decodeWebSocketPayload(req.Payload, &body); err != nil {
		_ = c.writeError(req.ID, "invalid fs.create_dir payload")
		return
	}

	workdir := strings.TrimSpace(body.Workdir)
	path := strings.TrimSpace(body.Path)
	if workdir == "" {
		_ = c.writeError(req.ID, "workdir is required")
		return
	}
	if path == "" {
		_ = c.writeError(req.ID, "path is required")
		return
	}

	response, err := c.awaitAgentResponse(req.ID, &gatewayv1.GatewayEnvelope{
		RequestId: req.ID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_FsCreateDir{
			FsCreateDir: &gatewayv1.FsCreateDirRequest{
				Workdir: workdir,
				Path:    path,
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

	resp := response.GetFsCreateDirResp()
	if resp == nil {
		_ = c.writeError(req.ID, "unexpected agent response")
		return
	}

	_ = c.writeResponse(req.ID, websocketFsCreateDirResponsePayload(resp))
}

func (c *websocketConnection) handleFsRename(req websocketRequest) {
	type payload struct {
		Workdir  string `json:"workdir"`
		FromPath string `json:"from_path"`
		ToPath   string `json:"to_path"`
	}

	var body payload
	if err := decodeWebSocketPayload(req.Payload, &body); err != nil {
		_ = c.writeError(req.ID, "invalid fs.rename payload")
		return
	}

	workdir := strings.TrimSpace(body.Workdir)
	fromPath := strings.TrimSpace(body.FromPath)
	toPath := strings.TrimSpace(body.ToPath)
	if workdir == "" {
		_ = c.writeError(req.ID, "workdir is required")
		return
	}
	if fromPath == "" {
		_ = c.writeError(req.ID, "from_path is required")
		return
	}
	if toPath == "" {
		_ = c.writeError(req.ID, "to_path is required")
		return
	}

	response, err := c.awaitAgentResponse(req.ID, &gatewayv1.GatewayEnvelope{
		RequestId: req.ID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_FsRename{
			FsRename: &gatewayv1.FsRenameRequest{
				Workdir:  workdir,
				FromPath: fromPath,
				ToPath:   toPath,
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

	resp := response.GetFsRenameResp()
	if resp == nil {
		_ = c.writeError(req.ID, "unexpected agent response")
		return
	}

	_ = c.writeResponse(req.ID, websocketFsRenameResponsePayload(resp))
}

func (c *websocketConnection) handleFsDelete(req websocketRequest) {
	type payload struct {
		Workdir string `json:"workdir"`
		Path    string `json:"path"`
	}

	var body payload
	if err := decodeWebSocketPayload(req.Payload, &body); err != nil {
		_ = c.writeError(req.ID, "invalid fs.delete payload")
		return
	}

	workdir := strings.TrimSpace(body.Workdir)
	path := strings.TrimSpace(body.Path)
	if workdir == "" {
		_ = c.writeError(req.ID, "workdir is required")
		return
	}
	if path == "" {
		_ = c.writeError(req.ID, "path is required")
		return
	}

	response, err := c.awaitAgentResponse(req.ID, &gatewayv1.GatewayEnvelope{
		RequestId: req.ID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv1.GatewayEnvelope_FsDelete{
			FsDelete: &gatewayv1.FsDeleteRequest{
				Workdir: workdir,
				Path:    path,
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

	resp := response.GetFsDeleteResp()
	if resp == nil {
		_ = c.writeError(req.ID, "unexpected agent response")
		return
	}

	_ = c.writeResponse(req.ID, websocketFsDeleteResponsePayload(resp))
}

func websocketFsListResponsePayload(resp *gatewayv1.FsListResponse) map[string]any {
	entryPayload := make([]map[string]any, 0, len(resp.GetEntries()))
	for _, entry := range resp.GetEntries() {
		entryPayload = append(entryPayload, map[string]any{
			"path": entry.GetPath(),
			"kind": entry.GetKind(),
		})
	}

	var path any
	if resp.GetHasPath() {
		path = resp.GetPath()
	}

	return map[string]any{
		"path":       path,
		"depth":      resp.GetDepth(),
		"offset":     resp.GetOffset(),
		"maxResults": resp.GetMaxResults(),
		"total":      resp.GetTotal(),
		"hasMore":    resp.GetHasMore(),
		"entries":    entryPayload,
	}
}

func websocketFsReadEditableTextResponsePayload(resp *gatewayv1.FsReadEditableTextResponse) map[string]any {
	return map[string]any{
		"path":        resp.GetPath(),
		"content":     resp.GetContent(),
		"mtimeMs":     resp.GetMtimeMs(),
		"contentHash": resp.GetContentHash(),
		"sizeBytes":   resp.GetSizeBytes(),
		"totalLines":  resp.GetTotalLines(),
	}
}

func websocketFsReadWorkspaceImageResponsePayload(resp *gatewayv1.FsReadWorkspaceImageResponse) map[string]any {
	return map[string]any{
		"path":        resp.GetPath(),
		"mimeType":    resp.GetMimeType(),
		"data":        resp.GetData(),
		"sizeBytes":   resp.GetSizeBytes(),
		"mtimeMs":     resp.GetMtimeMs(),
		"contentHash": resp.GetContentHash(),
	}
}

func websocketFsWriteTextResponsePayload(resp *gatewayv1.FsWriteTextResponse) map[string]any {
	return map[string]any{
		"path":          resp.GetPath(),
		"mode":          resp.GetMode(),
		"existedBefore": resp.GetExistedBefore(),
		"bytesWritten":  resp.GetBytesWritten(),
		"mtimeMs":       resp.GetMtimeMs(),
		"contentHash":   resp.GetContentHash(),
		"totalLines":    resp.GetTotalLines(),
	}
}

func websocketFsCreateDirResponsePayload(resp *gatewayv1.FsCreateDirResponse) map[string]any {
	return map[string]any{
		"path": resp.GetPath(),
		"kind": resp.GetKind(),
	}
}

func websocketFsRenameResponsePayload(resp *gatewayv1.FsRenameResponse) map[string]any {
	return map[string]any{
		"fromPath": resp.GetFromPath(),
		"path":     resp.GetPath(),
		"kind":     resp.GetKind(),
	}
}

func websocketFsDeleteResponsePayload(resp *gatewayv1.FsDeleteResponse) map[string]any {
	return map[string]any{
		"path": resp.GetPath(),
		"kind": resp.GetKind(),
	}
}
