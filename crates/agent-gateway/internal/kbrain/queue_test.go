package kbrain

import (
	"context"
	"encoding/json"
	"testing"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

func TestQueueInspectReorderEditDeleteUsesIdentityAndCAS(t *testing.T) {
	r, err := NewRelay(mustQueueClient(t), "target", ModelRef{Provider: "fixture", Model: "model"}, "/workspace")
	if err != nil {
		t.Fatal(err)
	}
	cb := Callbacks{OnQueue: func(string, string, uint64) {}}
	// Seed a busy active item, then two stable queued identities.
	r.mu.Lock()
	r.activeRuns["conv"] = "active"
	r.runs["active"] = &runState{gatewayRunID: "active", conversationID: "conv", cancel: func() {}}
	r.queues["conv"] = []queuedRun{
		{RunID: "one", ConversationID: "conv", Prompt: PromptRequest{Prompt: "one"}, CreatedAt: 1, Callbacks: cb, DraftJSON: defaultDraftJSON("one")},
		{RunID: "two", ConversationID: "conv", Prompt: PromptRequest{Prompt: "two"}, CreatedAt: 2, Callbacks: cb, DraftJSON: defaultDraftJSON("two")},
	}
	r.mu.Unlock()

	inspect := r.Queue(context.Background(), &gatewayv2.ChatQueueRequest{Action: "inspect", ConversationId: "conv"})
	if !inspect.Accepted || inspect.Revision != 0 {
		t.Fatalf("inspect = %#v", inspect)
	}
	var snapshot queueSnapshot
	if err := json.Unmarshal([]byte(inspect.SnapshotJSON), &snapshot); err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Items) != 2 || snapshot.Items[0].ID != "one" || snapshot.Items[1].ID != "two" {
		t.Fatalf("snapshot = %#v", snapshot)
	}

	moved := r.Queue(context.Background(), &gatewayv2.ChatQueueRequest{Action: "reorder", ConversationId: "conv", ItemId: "two", Direction: "up", Revision: inspect.Revision})
	if !moved.Accepted || moved.Revision != 1 {
		t.Fatalf("moved = %#v", moved)
	}
	stale := r.Queue(context.Background(), &gatewayv2.ChatQueueRequest{Action: "delete", ConversationId: "conv", ItemId: "one", Revision: 99})
	if stale.Accepted || stale.ErrorCode != "conflict" || stale.Revision != moved.Revision {
		t.Fatalf("stale = %#v", stale)
	}

	begin := r.Queue(context.Background(), &gatewayv2.ChatQueueRequest{Action: "edit_begin", ConversationId: "conv", ItemId: "two"})
	if !begin.Accepted || begin.ItemJSON == "" || begin.Revision != 2 {
		t.Fatalf("edit begin = %#v", begin)
	}
	commit := r.Queue(context.Background(), &gatewayv2.ChatQueueRequest{Action: "edit", ConversationId: "conv", ItemId: "two", Revision: begin.Revision, DraftJson: `{"text":"edited"}`, UploadedFilesJson: `[]`})
	if !commit.Accepted || commit.Revision != 3 {
		t.Fatalf("edit commit = %#v", commit)
	}
	deleted := r.Queue(context.Background(), &gatewayv2.ChatQueueRequest{Action: "delete", ConversationId: "conv", ItemId: "two", Revision: commit.Revision})
	if !deleted.Accepted || deleted.Revision != 4 {
		t.Fatalf("delete = %#v", deleted)
	}
	if got := r.Queue(context.Background(), &gatewayv2.ChatQueueRequest{Action: "delete", ConversationId: "conv", ItemId: "active"}); got.Accepted || got.ErrorCode != "active" {
		t.Fatalf("active item was not protected: %#v", got)
	}
}

func mustQueueClient(t *testing.T) *Client {
	t.Helper()
	client, err := New("http://127.0.0.1", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	return client
}
