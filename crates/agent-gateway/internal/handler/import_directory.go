package handler

import (
	"context"
	"io"
	"net/http"
	"strings"
	"time"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/session"
)

// 目录上传比单文件附件大得多（整个项目文件夹），上限独立于附件通道。
const maxDirectoryUploadBytes int64 = 200 << 20 // 200 MiB

const maxDirectoryUploadFiles = 2000

var directoryImportTargets = map[string]bool{
	"workspace":    true,
	"project-root": true,
}

// ImportDirectory 把浏览器拖入的文件夹（multipart，文件名即目录内相对路径）
// 转发给在线 Agent 落盘。网关自身不写磁盘，与 ImportReadableFiles 同构。
func ImportDirectory(
	sm *session.Manager,
	requestTimeout time.Duration,
) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		agentID := strings.TrimSpace(r.URL.Query().Get("agent_id"))
		if agentID == "" {
			writeError(w, http.StatusBadRequest, "agent_id is required")
			return
		}
		if !sm.IsOnline(agentID) {
			writeError(w, http.StatusServiceUnavailable, "agent offline")
			return
		}

		r.Body = http.MaxBytesReader(w, r.Body, maxDirectoryUploadBytes)
		if err := r.ParseMultipartForm(32 << 20); err != nil {
			status := http.StatusBadRequest
			message := "invalid multipart form"
			if strings.Contains(err.Error(), "http: request body too large") {
				status = http.StatusRequestEntityTooLarge
				message = "uploaded directory is too large"
			}
			writeError(w, status, message)
			return
		}
		if r.MultipartForm != nil {
			defer func() { _ = r.MultipartForm.RemoveAll() }()
		}

		name := strings.TrimSpace(r.FormValue("name"))
		if name == "" {
			writeError(w, http.StatusBadRequest, "name is required")
			return
		}
		target := strings.TrimSpace(r.FormValue("target"))
		if !directoryImportTargets[target] {
			writeError(w, http.StatusBadRequest, "target must be workspace or project-root")
			return
		}

		fileHeaders := r.MultipartForm.File["files"]
		if len(fileHeaders) == 0 {
			writeError(w, http.StatusBadRequest, "files is required")
			return
		}
		if len(fileHeaders) > maxDirectoryUploadFiles {
			writeError(w, http.StatusRequestEntityTooLarge, "uploaded directory has too many files")
			return
		}
		// multipart 的 filename 会被 Go 侧 filepath.Base 削成末段，目录内的
		// 相对路径改由与 files 按序对齐的 paths 字段承载。
		relativePaths := r.MultipartForm.Value["paths"]
		if len(relativePaths) != len(fileHeaders) {
			writeError(w, http.StatusBadRequest, "paths must align with files")
			return
		}

		uploads := make([]*gatewayv2.ImportDirectoryFile, 0, len(fileHeaders))
		for index, header := range fileHeaders {
			relativePath := strings.TrimSpace(relativePaths[index])
			if relativePath == "" {
				writeError(w, http.StatusBadRequest, "paths must align with files")
				return
			}
			file, err := header.Open()
			if err != nil {
				writeError(w, http.StatusBadRequest, "failed to read uploaded files")
				return
			}

			content, readErr := io.ReadAll(file)
			closeErr := file.Close()
			if readErr != nil {
				writeError(w, http.StatusBadRequest, "failed to read uploaded files")
				return
			}
			if closeErr != nil {
				writeError(w, http.StatusBadRequest, "failed to finalize uploaded files")
				return
			}

			uploads = append(uploads, &gatewayv2.ImportDirectoryFile{
				RelativePath: relativePath,
				Content:      content,
			})
		}

		ctx, cancel := context.WithTimeout(r.Context(), requestTimeout)
		defer cancel()

		requestID := newRequestID()
		ch, done, cleanup, err := sm.RegisterStreamAndSendContext(ctx, agentID, requestID, &gatewayv2.GatewayEnvelope{
			RequestId: requestID,
			Timestamp: time.Now().Unix(),
			Payload: &gatewayv2.GatewayEnvelope_ImportDirectory{
				ImportDirectory: &gatewayv2.ImportDirectoryRequest{
					Name:   name,
					Target: target,
					Files:  uploads,
				},
			},
		})
		if err != nil {
			writeError(w, http.StatusServiceUnavailable, "agent offline")
			return
		}
		defer cleanup()

		env, err := waitForEnvelope(ctx, ch, done)
		if err != nil {
			writeError(w, http.StatusGatewayTimeout, errorMessage(err, "request failed"))
			return
		}
		if errResp := env.GetError(); errResp != nil {
			writeError(w, GatewayErrorStatus(errResp), errResp.GetMessage())
			return
		}

		resp := env.GetImportDirectoryResp()
		if resp == nil {
			writeError(w, http.StatusBadGateway, "unexpected agent response")
			return
		}

		writeJSON(w, http.StatusOK, map[string]any{
			"rootPath":  resp.GetRootPath(),
			"fileCount": resp.GetFileCount(),
			"skipped":   resp.GetSkipped(),
		})
	}
}
