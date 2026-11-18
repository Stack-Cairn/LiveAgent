package kbrain

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"google.golang.org/protobuf/proto"
)

func TestFilesystemPreviewOffsetPresenceAndProjection(t *testing.T) {
	for _, offset := range []*uint64{nil, proto.Uint64(0), proto.Uint64(1048576)} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			var input map[string]json.RawMessage
			if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
				t.Error(err)
				return
			}
			value, present := input["preview_offset"]
			if present != (offset != nil) {
				t.Errorf("preview_offset presence = %v, offset = %v", present, offset)
			}
			response := map[string]any{"path": "file", "content": "猫", "size_bytes": 2000000}
			if offset != nil {
				var forwarded uint64
				if err := json.Unmarshal(value, &forwarded); err != nil || forwarded != *offset {
					t.Errorf("preview_offset = %s, error = %v", value, err)
				}
				response["preview_offset"] = *offset
				response["preview_next_offset"] = *offset + 3
			}
			_ = json.NewEncoder(w).Encode(response)
		}))
		client, _ := New(server.URL, "token", server.Client())
		relay, _ := NewRelay(client, "kb", ModelRef{}, "")
		out, handled, err := relay.Filesystem(context.Background(), &gatewayv2.GatewayEnvelope{Payload: &gatewayv2.GatewayEnvelope_FsReadEditableText{FsReadEditableText: &gatewayv2.FsReadEditableTextRequest{
			Workdir: "/work", Path: "file", PreviewOffset: offset,
		}}})
		relay.Close()
		server.Close()
		if err != nil || !handled {
			t.Fatalf("preview read: %v, handled=%v", err, handled)
		}
		response := out.GetFsReadEditableTextResp()
		if (response.PreviewOffset != nil) != (offset != nil) || (response.PreviewNextOffset != nil) != (offset != nil) {
			t.Fatal("optional response presence lost")
		}
		if offset != nil && (response.GetPreviewOffset() != *offset || response.GetPreviewNextOffset() != *offset+3) {
			t.Fatal("preview byte offsets changed")
		}
	}
}

func TestFilesystemLargeSaveHTTPAndConflictGuards(t *testing.T) {
	var calls atomic.Int32
	expected := make(chan string, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		var body struct {
			Action        string  `json:"action"`
			Content       string  `json:"content"`
			ExpectedMtime *uint64 `json:"expected_mtime_ms"`
			ExpectedHash  *string `json:"expected_content_hash"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
			return
		}
		want := <-expected
		if body.Action != "write_text" || body.Content != want || body.ExpectedMtime == nil || *body.ExpectedMtime != 0 || body.ExpectedHash == nil || *body.ExpectedHash != "original" {
			t.Error("HTTP relay lost content or conflict guard presence")
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"path": "file", "bytes_written": len(body.Content), "content_hash": "saved"})
	}))
	defer server.Close()
	client, _ := New(server.URL, "token", server.Client())
	relay, _ := NewRelay(client, "kb", ModelRef{}, "")
	defer relay.Close()
	for _, content := range []string{strings.Repeat("x", (4<<20)+1), strings.Repeat("\x00", 1<<20), strings.Repeat("x", 16<<20)} {
		expected <- content
		out, handled, err := relay.Filesystem(context.Background(), &gatewayv2.GatewayEnvelope{Payload: &gatewayv2.GatewayEnvelope_FsWriteText{FsWriteText: &gatewayv2.FsWriteTextRequest{
			Workdir: "/work", Path: "file", Content: content, Mode: "overwrite",
			HasExpectedMtimeMs: true, ExpectedMtimeMs: 0, HasExpectedContentHash: true, ExpectedContentHash: "original",
		}}})
		if err != nil || !handled || out.GetFsWriteTextResp().GetBytesWritten() != uint64(len(content)) {
			t.Fatalf("save bytes=%d, handled=%v, error=%v", len(content), handled, err)
		}
	}
	before := calls.Load()
	if _, handled, err := relay.Filesystem(context.Background(), &gatewayv2.GatewayEnvelope{Payload: &gatewayv2.GatewayEnvelope_FsWriteText{FsWriteText: &gatewayv2.FsWriteTextRequest{Content: strings.Repeat("x", (16<<20)+1)}}}); !handled || err == nil || calls.Load() != before {
		t.Fatal("oversized text reached backend")
	}
}

func TestFilesystemHTTPConflictMessageSurvives(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnprocessableEntity)
		_, _ = io.WriteString(w, `{"error":"FILE_CONFLICT: destination changed"}`)
	}))
	defer server.Close()
	client, _ := New(server.URL, "token", server.Client())
	relay, _ := NewRelay(client, "kb", ModelRef{}, "")
	defer relay.Close()
	_, handled, err := relay.Filesystem(context.Background(), &gatewayv2.GatewayEnvelope{Payload: &gatewayv2.GatewayEnvelope_FsWriteText{FsWriteText: &gatewayv2.FsWriteTextRequest{Content: "text"}}})
	if !handled || err == nil || !strings.Contains(err.Error(), "FILE_CONFLICT") {
		t.Fatalf("conflict was lost: %v", err)
	}
}

func TestLimitedHTTPRejectsOversizedSendAndRead(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		_, _ = io.WriteString(w, `{"value":"`+strings.Repeat("x", 64)+`"}`)
	}))
	defer server.Close()
	client, _ := New(server.URL, "token", server.Client())
	var output json.RawMessage
	if _, err := client.requestLimited(context.Background(), "POST", "/v1/fs", map[string]string{"value": strings.Repeat("x", 64)}, &output, 32, 32); err == nil || calls.Load() != 0 {
		t.Fatal("oversized send was not stopped before HTTP")
	}
	if _, err := client.requestLimited(context.Background(), "POST", "/v1/fs", map[string]string{"value": "a"}, &output, 32, 32); err == nil || !strings.Contains(err.Error(), "response exceeds") {
		t.Fatalf("oversized read was accepted: %v", err)
	}
}
