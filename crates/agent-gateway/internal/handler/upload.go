package handler

import (
	"context"
	"io"
	"net/http"
	"strings"
	"time"

	"google.golang.org/protobuf/proto"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/session"
)

// Desktop's tungstenite transport accepts at most 16 MiB in a single frame.
// Bound the HTTP body too, then check the encoded envelope including metadata.
const maxReadableUploadBytes int64 = 16 << 20
const maxReadableUploadFrameBytes = 16 << 20

func ImportReadableFiles(
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

		r.Body = http.MaxBytesReader(w, r.Body, maxReadableUploadBytes)
		if err := r.ParseMultipartForm(32 << 20); err != nil {
			status := http.StatusBadRequest
			message := "invalid multipart form"
			if strings.Contains(err.Error(), "http: request body too large") {
				status = http.StatusRequestEntityTooLarge
				message = "uploaded files are too large"
			}
			writeError(w, status, message)
			return
		}
		if r.MultipartForm != nil {
			defer func() { _ = r.MultipartForm.RemoveAll() }()
		}

		workdir := strings.TrimSpace(r.FormValue("workdir"))
		if workdir == "" {
			writeError(w, http.StatusBadRequest, "workdir is required")
			return
		}

		fileHeaders := r.MultipartForm.File["files"]
		if len(fileHeaders) == 0 {
			writeError(w, http.StatusBadRequest, "files is required")
			return
		}

		uploads := make([]*gatewayv2.UploadReadableFile, 0, len(fileHeaders))
		for _, header := range fileHeaders {
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

			uploads = append(uploads, &gatewayv2.UploadReadableFile{
				FileName: header.Filename,
				MimeType: strings.TrimSpace(header.Header.Get("Content-Type")),
				Content:  content,
			})
		}

		ctx, cancel := context.WithTimeout(r.Context(), requestTimeout)
		defer cancel()

		requestID := newRequestID()
		envelope := &gatewayv2.GatewayEnvelope{
			RequestId: requestID,
			Timestamp: time.Now().Unix(),
			Payload: &gatewayv2.GatewayEnvelope_UploadReadableFiles{
				UploadReadableFiles: &gatewayv2.UploadReadableFilesRequest{
					Workdir: workdir,
					Files:   uploads,
				},
			},
		}
		frame := &gatewayv2.AgentServerFrame{Payload: &gatewayv2.AgentServerFrame_Envelope{Envelope: envelope}}
		if proto.Size(frame) > maxReadableUploadFrameBytes {
			writeError(w, http.StatusRequestEntityTooLarge, "uploaded files exceed desktop transfer limit (16 MiB including metadata)")
			return
		}
		ch, done, cleanup, err := sm.RegisterStreamAndSendContext(ctx, agentID, requestID, envelope)
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

		resp := env.GetUploadReadableFilesResp()
		if resp == nil {
			writeError(w, http.StatusBadGateway, "unexpected agent response")
			return
		}

		files := make([]map[string]any, 0, len(resp.GetFiles()))
		for _, file := range resp.GetFiles() {
			files = append(files, map[string]any{
				"relativePath": file.GetRelativePath(),
				"absolutePath": file.GetAbsolutePath(),
				"dedupeKey":    file.GetDedupeKey(),
				"fileName":     file.GetFileName(),
				"kind":         file.GetKind(),
				"sizeBytes":    file.GetSizeBytes(),
			})
		}

		writeJSON(w, http.StatusOK, map[string]any{
			"files":   files,
			"skipped": resp.GetSkipped(),
		})
	}
}
