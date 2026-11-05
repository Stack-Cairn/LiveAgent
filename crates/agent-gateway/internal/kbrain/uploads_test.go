package kbrain

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

// A 1x1 PNG.
var testPNG, _ = base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")

func TestUploadStoreInlinesAttachmentsAsContent(t *testing.T) {
	store := NewUploadStore()
	image, skipped := store.Put("photo.png", "application/octet-stream", testPNG)
	if skipped != "" || image.Kind != "image" || !strings.HasPrefix(image.RelativePath, uploadPathPrefix) || image.SizeBytes != int64(len(testPNG)) || !strings.HasPrefix(image.DedupeKey, "sha256:") {
		t.Fatalf("image = %+v skipped=%q", image, skipped)
	}
	text, skipped := store.Put("../notes.md", "", []byte("# Notes\n```go\nx\n```\n"))
	if skipped != "" || text.Kind != "text" || text.FileName != "notes.md" {
		t.Fatalf("text = %+v skipped=%q", text, skipped)
	}
	pdf, skipped := store.Put("paper.pdf", "application/pdf", []byte("%PDF-1.4\n%fixture\n"))
	if skipped != "" || pdf.Kind != "pdf" {
		t.Fatalf("pdf = %+v skipped=%q", pdf, skipped)
	}
	blocks, err := store.Content([]string{image.RelativePath, text.RelativePath, pdf.RelativePath})
	if err != nil || len(blocks) != 3 {
		t.Fatalf("blocks = %+v err=%v", blocks, err)
	}
	if blocks[0].Type != "image" || blocks[0].MIMEType != "image/png" || blocks[0].ImageURL != "data:image/png;base64,"+base64.StdEncoding.EncodeToString(testPNG) {
		t.Fatalf("image block = %+v", blocks[0])
	}
	if blocks[1].Type != "text" || !strings.Contains(blocks[1].Text, "Attached file notes.md:\n````\n# Notes") {
		t.Fatalf("text block must fence past the file's own fences: %q", blocks[1].Text)
	}
	if blocks[2].Type != "file" || blocks[2].Filename != "paper.pdf" || blocks[2].MIMEType != "application/pdf" || !strings.HasPrefix(blocks[2].FileURL, "data:application/pdf;base64,") {
		t.Fatalf("pdf block = %+v", blocks[2])
	}
	if _, err := store.Content([]string{uploadPathPrefix + "missing/x.png"}); err != errUploadMissing {
		t.Fatalf("missing attachment err = %v", err)
	}
	if _, err := store.Content([]string{"/workspace/photo.png"}); err != errUploadMissing {
		t.Fatalf("desktop path err = %v", err)
	}
}

func TestUploadStoreRejectsUnsupportedAndOversizedFiles(t *testing.T) {
	store := NewUploadStore()
	for name, data := range map[string][]byte{
		"archive.zip": {'P', 'K', 3, 4, 0, 0, 0xff, 0xfe},
		"empty.txt":   {},
		"big.txt":     bytes.Repeat([]byte("a"), MaxUploadMessageBytes+1),
		"report.docx": []byte("PK\x03\x04 word"),
	} {
		if file, skipped := store.Put(name, "", data); skipped == "" {
			t.Fatalf("%s stored as %+v", name, file)
		}
	}
	a, _ := store.Put("a.txt", "", bytes.Repeat([]byte("a"), MaxUploadMessageBytes/2+1))
	b, _ := store.Put("b.txt", "", bytes.Repeat([]byte("b"), MaxUploadMessageBytes/2+1))
	if _, err := store.Content([]string{a.RelativePath, b.RelativePath}); err == nil || !strings.Contains(err.Error(), "exceed") {
		t.Fatalf("oversized message err = %v", err)
	}
}

func TestUploadStoreExpiresAndEvicts(t *testing.T) {
	store := NewUploadStore()
	now := time.Unix(1000, 0)
	store.now = func() time.Time { return now }
	old, _ := store.Put("old.txt", "", []byte("old"))
	now = now.Add(uploadTTL + time.Second)
	fresh, _ := store.Put("fresh.txt", "", []byte("fresh"))
	if _, err := store.Content([]string{old.RelativePath}); err != errUploadMissing {
		t.Fatalf("expired attachment err = %v", err)
	}
	if _, err := store.Content([]string{fresh.RelativePath}); err != nil {
		t.Fatalf("fresh attachment err = %v", err)
	}
	for i := 0; i < maxUploadFiles; i++ {
		store.Put("n.txt", "", []byte("n"))
	}
	if _, err := store.Content([]string{fresh.RelativePath}); err != errUploadMissing {
		t.Fatalf("oldest attachment was not evicted: %v", err)
	}
	if len(store.order) != maxUploadFiles || len(store.items) != maxUploadFiles {
		t.Fatalf("store holds %d/%d files", len(store.order), len(store.items))
	}
}

func TestUploadImportHandlerAnswersLikeTheDesktop(t *testing.T) {
	store := NewUploadStore()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	_ = writer.WriteField("workdir", "/workspace")
	part, _ := writer.CreateFormFile("files", "photo.png")
	_, _ = part.Write(testPNG)
	part, _ = writer.CreateFormFile("files", "tool.exe")
	_, _ = part.Write([]byte{0x4d, 0x5a, 0x90, 0x00, 0x03})
	_ = writer.Close()
	req := httptest.NewRequest(http.MethodPost, "/api/files/import?agent_id=kbrain", &body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	rec := httptest.NewRecorder()
	store.ImportHandler(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	var out struct {
		Files   []map[string]any `json:"files"`
		Skipped []string         `json:"skipped"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if len(out.Files) != 1 || out.Files[0]["kind"] != "image" || out.Files[0]["fileName"] != "photo.png" || out.Files[0]["relativePath"] == "" {
		t.Fatalf("files = %+v", out.Files)
	}
	if len(out.Skipped) != 1 || !strings.Contains(out.Skipped[0], "tool.exe") {
		t.Fatalf("skipped = %+v", out.Skipped)
	}
}

func TestRelayStartsRunWithAttachmentOnlyPrompt(t *testing.T) {
	var runBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/sessions":
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"id":"kb-session"}`))
		case "/v1/sessions/kb-session/runs":
			_ = json.NewDecoder(r.Body).Decode(&runBody)
			w.WriteHeader(http.StatusAccepted)
			_, _ = w.Write([]byte(`{"version":"kbrain.agent.v1","conversation_id":"kb-session","run_id":"kb-run","accepted_seq":1}`))
		case "/v1/sessions/kb-session/events":
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = w.Write([]byte("data: {\"version\":\"kbrain.agent.v1\",\"seq\":1,\"conversation_id\":\"kb-session\",\"run_id\":\"kb-run\",\"type\":\"run.completed\",\"payload\":{\"state\":\"completed\"}}\n\n"))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	client, err := New(srv.URL, "", srv.Client())
	if err != nil {
		t.Fatal(err)
	}
	relay, err := NewRelay(client, "kbrain", ModelRef{Provider: "fixture", Model: "fixture-model"}, "/workspace")
	if err != nil {
		t.Fatal(err)
	}
	image, _ := relay.Uploads().Put("photo.png", "", testPNG)
	content, err := relay.Uploads().Content([]string{image.RelativePath})
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	_, err = relay.StartWithCWD(t.Context(), "gw-run", "conv-1", "client-1", "/workspace", PromptRequest{Content: content, HookPolicy: "backend", HookScopeID: "conv-1"}, "auto", Callbacks{
		OnControl: func(_ string, control *gatewayv2.ChatControlEvent) {
			if control.Type == "completed" {
				close(done)
			}
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("run did not complete")
	}
	blocks, _ := runBody["content"].([]any)
	if len(blocks) != 1 || blocks[0].(map[string]any)["type"] != "image" || runBody["hook_policy"] != "backend" || runBody["hook_scope_id"] != "conv-1" {
		t.Fatalf("run body = %+v", runBody)
	}
	if _, ok := runBody["prompt"]; ok {
		t.Fatalf("empty prompt must be omitted: %+v", runBody)
	}
}
