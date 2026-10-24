package kbrain

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

func TestFilesystemTypedProjection(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/fs" || r.Method != "POST" || r.Header.Get("Authorization") != "Bearer fs-token" {
			t.Errorf("unexpected filesystem route: %s %s", r.Method, r.URL)
		}
		var input map[string]any
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			t.Fatal(err)
		}
		w.Header().Set("Content-Type", "application/json")
		switch input["action"] {
		case "roots":
			_, _ = w.Write([]byte(`{"roots":[{"id":"backend-0","path":"/project","kind":"workspace"}]}`))
		case "read_text":
			if input["workdir"] != "/project" || input["path"] != "file.txt" {
				t.Error(input)
			}
			_, _ = w.Write([]byte(`{"path":"file.txt","content":"hello","mtime_ms":123,"content_hash":"hash","size_bytes":5,"total_lines":1}`))
		case "delete":
			_, _ = w.Write([]byte(`{"path":"file.txt","kind":"file"}`))
		case "read_preview":
			_, _ = w.Write([]byte(`{"path":"file.txt","data":"aGVsbG8=","mime_type":"text/plain","mtime_ms":123,"content_hash":"hash","size_bytes":5}`))
		default:
			t.Error(input)
		}
	}))
	defer server.Close()
	client, _ := New(server.URL, "fs-token", server.Client())
	relay, _ := NewRelay(client, "kb", ModelRef{}, "")
	defer relay.Close()
	out, handled, err := relay.Filesystem(context.Background(), &gatewayv2.GatewayEnvelope{Payload: &gatewayv2.GatewayEnvelope_FsRoots{FsRoots: &gatewayv2.FsRootsRequest{}}})
	if err != nil || !handled || len(out.GetFsRootsResp().GetRoots()) != 1 {
		t.Fatalf("roots=%v handled=%v err=%v", out, handled, err)
	}
	out, handled, err = relay.Filesystem(context.Background(), &gatewayv2.GatewayEnvelope{Payload: &gatewayv2.GatewayEnvelope_FsReadEditableText{FsReadEditableText: &gatewayv2.FsReadEditableTextRequest{Workdir: "/project", Path: "file.txt"}}})
	if err != nil || !handled || out.GetFsReadEditableTextResp().GetMtimeMs() != 123 || out.GetFsReadEditableTextResp().GetContentHash() != "hash" {
		t.Fatalf("read=%v handled=%v err=%v", out, handled, err)
	}
	out, handled, err = relay.Filesystem(context.Background(), &gatewayv2.GatewayEnvelope{Payload: &gatewayv2.GatewayEnvelope_FsReadWorkspaceImage{FsReadWorkspaceImage: &gatewayv2.FsReadWorkspaceImageRequest{Workdir: "/project", Path: "file.txt"}}})
	if err != nil || !handled || out.GetFsReadWorkspaceImageResp().GetData() != "aGVsbG8=" || out.GetFsReadWorkspaceImageResp().GetMimeType() != "text/plain" {
		t.Fatalf("preview=%v err=%v", out, err)
	}
	if out, handled, err := relay.Filesystem(context.Background(), &gatewayv2.GatewayEnvelope{Payload: &gatewayv2.GatewayEnvelope_FsDelete{FsDelete: &gatewayv2.FsDeleteRequest{Workdir: "/project", Path: "file.txt"}}}); err != nil || !handled || out.GetFsDeleteResp().GetPath() != "file.txt" {
		t.Fatal("delete was not projected")
	}
}
