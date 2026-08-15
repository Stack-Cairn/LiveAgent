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
// 内容总量与 Agent 端一致；HTTP body 另留 multipart 元数据空间。
const maxDirectoryUploadBytes int64 = 200 << 20 // 200 MiB

const maxDirectoryUploadBodyBytes int64 = maxDirectoryUploadBytes + (8 << 20)

const maxDirectoryUploadFiles = 2000

// Go WebSocket 服务端会把一条 protobuf 写成一个 frame；每块保持远低于
// tungstenite 默认的 16 MiB frame 上限，避免大目录中断 Agent 主连接。
const directoryImportChunkBytes = 1 << 20 // 1 MiB

var directoryImportTargets = map[string]bool{
	"workspace":    true,
	"project-root": true,
}

func sendImportDirectoryRequest(
	ctx context.Context,
	sm *session.Manager,
	agentID string,
	request *gatewayv2.ImportDirectoryRequest,
) (*gatewayv2.ImportDirectoryResponse, int, string) {
	requestID := newRequestID()
	ch, done, cleanup, err := sm.RegisterStreamAndSendContext(ctx, agentID, requestID, &gatewayv2.GatewayEnvelope{
		RequestId: requestID,
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv2.GatewayEnvelope_ImportDirectory{
			ImportDirectory: request,
		},
	})
	if err != nil {
		return nil, http.StatusServiceUnavailable, errorMessage(err, "agent offline")
	}
	defer cleanup()

	env, err := waitForEnvelope(ctx, ch, done)
	if err != nil {
		return nil, http.StatusGatewayTimeout, errorMessage(err, "request failed")
	}
	if errResp := env.GetError(); errResp != nil {
		return nil, GatewayErrorStatus(errResp), errResp.GetMessage()
	}
	resp := env.GetImportDirectoryResp()
	if resp == nil {
		return nil, http.StatusBadGateway, "unexpected agent response"
	}
	return resp, 0, ""
}

func abortDirectoryImport(
	sm *session.Manager,
	agentID string,
	transferID string,
	requestTimeout time.Duration,
) {
	timeout := requestTimeout
	if timeout <= 0 || timeout > 5*time.Second {
		timeout = 5 * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	_, _, _ = sendImportDirectoryRequest(ctx, sm, agentID, &gatewayv2.ImportDirectoryRequest{
		TransferId: transferID,
		Operation:  gatewayv2.ImportDirectoryOperation_IMPORT_DIRECTORY_OPERATION_ABORT,
	})
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

		r.Body = http.MaxBytesReader(w, r.Body, maxDirectoryUploadBodyBytes)
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

		var totalBytes uint64
		for index, header := range fileHeaders {
			if strings.TrimSpace(relativePaths[index]) == "" || header.Size < 0 {
				writeError(w, http.StatusBadRequest, "paths must align with files")
				return
			}
			totalBytes += uint64(header.Size)
			if totalBytes > uint64(maxDirectoryUploadBytes) {
				writeError(w, http.StatusRequestEntityTooLarge, "uploaded directory is too large")
				return
			}
		}

		ctx, cancel := context.WithTimeout(r.Context(), requestTimeout)
		defer cancel()

		transferID := newRequestID()
		committed := false
		defer func() {
			if !committed {
				abortDirectoryImport(sm, agentID, transferID, requestTimeout)
			}
		}()
		if _, status, message := sendImportDirectoryRequest(ctx, sm, agentID, &gatewayv2.ImportDirectoryRequest{
			Name:       name,
			Target:     target,
			TransferId: transferID,
			Operation:  gatewayv2.ImportDirectoryOperation_IMPORT_DIRECTORY_OPERATION_START,
			TotalFiles: uint32(len(fileHeaders)),
			TotalBytes: totalBytes,
		}); status != 0 {
			writeError(w, status, message)
			return
		}

		buffer := make([]byte, directoryImportChunkBytes)
		for index, header := range fileHeaders {
			file, err := header.Open()
			if err != nil {
				writeError(w, http.StatusBadRequest, "failed to read uploaded files")
				return
			}
			relativePath := strings.TrimSpace(relativePaths[index])
			fileSize := uint64(header.Size)
			var offset uint64
			if fileSize == 0 {
				if _, status, message := sendImportDirectoryRequest(ctx, sm, agentID, &gatewayv2.ImportDirectoryRequest{
					TransferId:   transferID,
					Operation:    gatewayv2.ImportDirectoryOperation_IMPORT_DIRECTORY_OPERATION_WRITE_CHUNK,
					RelativePath: relativePath,
					FileComplete: true,
				}); status != 0 {
					_ = file.Close()
					writeError(w, status, message)
					return
				}
			}
			for offset < fileSize {
				remaining := fileSize - offset
				chunkSize := uint64(directoryImportChunkBytes)
				if remaining < chunkSize {
					chunkSize = remaining
				}
				n, readErr := io.ReadFull(file, buffer[:int(chunkSize)])
				if readErr != nil {
					_ = file.Close()
					writeError(w, http.StatusBadRequest, "failed to read uploaded files")
					return
				}
				nextOffset := offset + uint64(n)
				if _, status, message := sendImportDirectoryRequest(ctx, sm, agentID, &gatewayv2.ImportDirectoryRequest{
					TransferId:   transferID,
					Operation:    gatewayv2.ImportDirectoryOperation_IMPORT_DIRECTORY_OPERATION_WRITE_CHUNK,
					RelativePath: relativePath,
					Offset:       offset,
					Chunk:        append([]byte(nil), buffer[:n]...),
					FileComplete: nextOffset == fileSize,
				}); status != 0 {
					_ = file.Close()
					writeError(w, status, message)
					return
				}
				offset = nextOffset
			}
			if err := file.Close(); err != nil {
				writeError(w, http.StatusBadRequest, "failed to finalize uploaded files")
				return
			}
		}

		resp, status, message := sendImportDirectoryRequest(ctx, sm, agentID, &gatewayv2.ImportDirectoryRequest{
			TransferId: transferID,
			Operation:  gatewayv2.ImportDirectoryOperation_IMPORT_DIRECTORY_OPERATION_COMMIT,
		})
		if status != 0 {
			writeError(w, status, message)
			return
		}
		committed = true

		writeJSON(w, http.StatusOK, map[string]any{
			"rootPath":  resp.GetRootPath(),
			"fileCount": resp.GetFileCount(),
			"skipped":   resp.GetSkipped(),
		})
	}
}
