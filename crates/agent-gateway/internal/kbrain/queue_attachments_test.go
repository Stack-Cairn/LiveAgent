package kbrain

import (
	"encoding/json"
	"testing"
)

func TestEditedQueueAttachmentsFollowTheEditorOrder(t *testing.T) {
	r := &Relay{uploads: NewUploadStore()}
	original := PromptRequest{Prompt: "read", Content: []ContentBlock{
		{Type: "image", MIMEType: "image/png", ImageURL: dataURL("image/png", testPNG)},
		{Type: "text", Text: "\n\nAttached file notes.txt:\n```\nkept\n```"},
	}}
	var files []UploadedFile
	if err := json.Unmarshal([]byte(queuedAttachmentsJSON("item", original.Content)), &files); err != nil {
		t.Fatal(err)
	}
	fresh, why := r.uploads.Put("new.txt", "text/plain", []byte("new content"))
	if why != "" {
		t.Fatal(why)
	}
	selection, _ := json.Marshal([]UploadedFile{fresh, files[1]})
	edited, err := r.editedQueueRequest("item", original, `{"text":""}`, string(selection))
	if err != nil {
		t.Fatal(err)
	}
	resolved, err := r.uploads.Content([]string{fresh.RelativePath})
	if err != nil || len(edited.Content) != 2 || edited.Content[0] != resolved[0] || edited.Content[1] != original.Content[1] || edited.Prompt != "" {
		t.Fatalf("incorrect attachment-only edit: %+v (%v)", edited, err)
	}
	if _, err := r.editedQueueRequest("another", original, `{"text":"x"}`, string(selection)); err == nil {
		t.Fatal("stale reference from another item accepted")
	}
}
