package kbrain

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

const mentionTree = `{"entries":[
 {"path":"README.md","kind":"file"},
 {"path":"src","kind":"dir"},
 {"path":"src/app.ts","kind":"file"},
 {"path":"src/NOTES.md","kind":"file"},
 {"path":"node_modules","kind":"dir"},
 {"path":"node_modules/pkg/readme.md","kind":"file"},
 {"path":"docs/guide/readme-extra.md","kind":"file"}]}`

func mentionRelay(t *testing.T, handle func(input map[string]any, w http.ResponseWriter)) (*Relay, *[]map[string]any) {
	t.Helper()
	var calls []map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/fs" || r.Method != "POST" {
			t.Errorf("unexpected route: %s %s", r.Method, r.URL)
		}
		var input map[string]any
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			t.Fatal(err)
		}
		calls = append(calls, input)
		w.Header().Set("Content-Type", "application/json")
		handle(input, w)
	}))
	t.Cleanup(server.Close)
	client, _ := New(server.URL, "fs-token", server.Client())
	relay, _ := NewRelay(client, "kb", ModelRef{}, "")
	t.Cleanup(relay.Close)
	return relay, &calls
}

func mentionRequest(query string, maxResults uint32) *gatewayv2.GatewayEnvelope {
	return &gatewayv2.GatewayEnvelope{Payload: &gatewayv2.GatewayEnvelope_FileMentionList{FileMentionList: &gatewayv2.FileMentionListRequest{Workdir: "/ws", MaxResults: maxResults, Query: query}}}
}

func mentionPaths(out *gatewayv2.AgentEnvelope) []string {
	var paths []string
	for _, entry := range out.GetFileMentionListResp().GetEntries() {
		paths = append(paths, entry.GetPath())
	}
	return paths
}

func TestFileMentionListServedFromKBrainListWalk(t *testing.T) {
	relay, calls := mentionRelay(t, func(_ map[string]any, w http.ResponseWriter) { _, _ = w.Write([]byte(mentionTree)) })
	out, handled, err := relay.Filesystem(context.Background(), mentionRequest("", 5000))
	if err != nil || !handled {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
	want := []string{"src", "README.md", "src/app.ts", "src/NOTES.md", "docs/guide/readme-extra.md"}
	if got := mentionPaths(out); !reflect.DeepEqual(got, want) {
		t.Fatalf("paths=%v want %v", got, want)
	}
	if call := (*calls)[0]; call["action"] != "list" || call["workdir"] != "/ws" || call["depth"] != float64(8) || call["max_results"] != float64(10000) {
		t.Fatalf("walk request=%v", call)
	}
	if out.GetFileMentionListResp().GetTruncated() {
		t.Fatal("small tree must not be truncated")
	}

	out, _, _ = relay.Filesystem(context.Background(), mentionRequest("@README", 5000))
	if got := mentionPaths(out); !reflect.DeepEqual(got, []string{"README.md", "docs/guide/readme-extra.md"}) {
		t.Fatalf("query paths=%v", got)
	}
	out, _, _ = relay.Filesystem(context.Background(), mentionRequest("", 2))
	if got := mentionPaths(out); !reflect.DeepEqual(got, []string{"src", "README.md"}) || !out.GetFileMentionListResp().GetTruncated() {
		t.Fatalf("capped paths=%v truncated=%v", got, out.GetFileMentionListResp().GetTruncated())
	}
}

func TestFileMentionListFallsBackOnLargeTreesAndKeepsReasons(t *testing.T) {
	relay, calls := mentionRelay(t, func(input map[string]any, w http.ResponseWriter) {
		if input["depth"].(float64) > 2 {
			w.WriteHeader(http.StatusUnprocessableEntity)
			_, _ = w.Write([]byte(`{"error":"filesystem tree exceeds 10000 entries; narrow path or depth"}`))
			return
		}
		_, _ = w.Write([]byte(`{"entries":[{"path":"README.md","kind":"file"}]}`))
	})
	out, _, err := relay.Filesystem(context.Background(), mentionRequest("", 5000))
	if err != nil || len(mentionPaths(out)) != 1 || !out.GetFileMentionListResp().GetTruncated() {
		t.Fatalf("out=%v err=%v", out, err)
	}
	var depths []float64
	for _, call := range *calls {
		depths = append(depths, call["depth"].(float64))
	}
	if !reflect.DeepEqual(depths, []float64{8, 4, 2}) {
		t.Fatalf("depths=%v", depths)
	}

	denied, _ := mentionRelay(t, func(_ map[string]any, w http.ResponseWriter) {
		w.WriteHeader(http.StatusUnprocessableEntity)
		_, _ = w.Write([]byte(`{"error":"filesystem path is outside configured roots"}`))
	})
	_, handled, err := denied.Filesystem(context.Background(), mentionRequest("", 5000))
	if !handled || err == nil || !strings.Contains(err.Error(), "outside configured roots") {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
}
