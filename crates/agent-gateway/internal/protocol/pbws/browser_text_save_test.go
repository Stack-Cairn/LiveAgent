package pbws

import (
	"bytes"
	"strings"
	"testing"
	"time"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/transport/wscore"
	"google.golang.org/protobuf/proto"
)

func newTextSaveCollector(t *testing.T) *browserConn {
	t.Helper()
	c := &browserConn{}
	c.core = wscore.NewConn(nil, wscore.Config{OnClose: c.releaseSubscriptions})
	c.done = c.core.Done()
	t.Cleanup(c.core.Close)
	return c
}

func textSaveMetadata(sftp bool) *gatewayv2.GatewayEnvelope {
	if sftp {
		return &gatewayv2.GatewayEnvelope{Payload: &gatewayv2.GatewayEnvelope_SftpRequest{SftpRequest: &gatewayv2.SftpRequest{
			Action: "write_text", SessionId: "session", RemotePath: "/file", Overwrite: true,
			ExpectedMtime: 17, ExpectedSizeBytes: 23, CreateParentDirs: true,
		}}}
	}
	return &gatewayv2.GatewayEnvelope{Payload: &gatewayv2.GatewayEnvelope_FsWriteText{FsWriteText: &gatewayv2.FsWriteTextRequest{
		Workdir: "/work", Path: "file", Mode: "overwrite",
		ExpectedMtimeMs: 17, HasExpectedMtimeMs: true, ExpectedContentHash: "original", HasExpectedContentHash: true,
	}}}
}

func textSaveChunk(id, agent string, total, offset uint64, data []byte, request *gatewayv2.GatewayEnvelope) *gatewayv2.WebClientFrame {
	return &gatewayv2.WebClientFrame{RequestId: id, AgentId: agent, Payload: &gatewayv2.WebClientFrame_AgentRequestChunk{AgentRequestChunk: &gatewayv2.AgentRequestChunk{
		Request: request, TotalBytes: total, Offset: offset, Data: data,
	}}}
}

func TestTextSaveCollectsBothWriteKindsAndPreservesConflictMetadata(t *testing.T) {
	for _, sftp := range []bool{false, true} {
		t.Run(map[bool]string{false: "filesystem", true: "sftp"}[sftp], func(t *testing.T) {
			c := newTextSaveCollector(t)
			// Split inside a UTF-8 code point and include escaped JSON/control bytes.
			content := []byte("a猫\x00\"\\\n")
			metadata := textSaveMetadata(sftp)
			expected := proto.Clone(metadata).(*gatewayv2.GatewayEnvelope)
			if sftp {
				expected.GetSftpRequest().Content = string(content)
			} else {
				expected.GetFsWriteText().Content = string(content)
			}
			out, err := c.collectTextSave(textSaveChunk("save", "agent", uint64(len(content)), 0, content[:2], metadata))
			if err != nil || out != nil {
				t.Fatalf("incomplete upload dispatched: %v, %v", out, err)
			}
			// The collector owns a clone of the first chunk's metadata.
			if sftp {
				metadata.GetSftpRequest().RemotePath = "/changed"
			} else {
				metadata.GetFsWriteText().Path = "changed"
			}
			out, err = c.collectTextSave(textSaveChunk("save", "agent", uint64(len(content)), 2, content[2:], nil))
			if err != nil || !proto.Equal(out, expected) {
				t.Fatalf("assembled request differs: %v, %v", out, err)
			}
			// Even after collection, a slow dispatch must retain the one-save slot.
			if _, err := c.collectTextSave(textSaveChunk("other", "agent", 2, 0, []byte("x"), textSaveMetadata(sftp))); err == nil {
				t.Fatal("second upload admitted while dispatch is pending")
			}
		})
	}
}

func TestTextSaveCompletionCannotReleaseTheNextUpload(t *testing.T) {
	c := newTextSaveCollector(t)
	completed, err := c.collectTextSave(textSaveChunk("first", "agent", 1, 0, []byte("a"), textSaveMetadata(false)))
	if err != nil || completed == nil {
		t.Fatalf("first save: %v", err)
	}
	// A request with equal fields but different ownership cannot finish it.
	c.finishTextSaveRequest(proto.Clone(completed).(*gatewayv2.GatewayEnvelope))
	if c.textSave == nil {
		t.Fatal("unrelated dispatch released active save")
	}
	c.finishTextSaveRequest(completed)
	// This models the next upload arriving as soon as the final response is
	// visible, before the previous dispatch's deferred cleanup has run.
	if _, err := c.collectTextSave(textSaveChunk("second", "agent", 2, 0, []byte("b"), textSaveMetadata(false))); err != nil {
		t.Fatal(err)
	}
	c.finishTextSaveRequest(completed)
	if c.textSave == nil || c.textSave.requestID != "second" {
		t.Fatal("previous dispatch cleanup released the next upload")
	}
}

func TestTextSaveRejectsMalformedAndUnscopedChunks(t *testing.T) {
	for _, tc := range []struct {
		name   string
		mutate func(*gatewayv2.WebClientFrame)
	}{
		{"request identity", func(f *gatewayv2.WebClientFrame) { f.RequestId = "other" }},
		{"agent identity", func(f *gatewayv2.WebClientFrame) { f.AgentId = "other" }},
		{"out of order", func(f *gatewayv2.WebClientFrame) { f.GetAgentRequestChunk().Offset = 0 }},
		{"declared total changed", func(f *gatewayv2.WebClientFrame) { f.GetAgentRequestChunk().TotalBytes = 4 }},
		{"overrun", func(f *gatewayv2.WebClientFrame) { f.GetAgentRequestChunk().Data = []byte("abc") }},
		{"empty chunk", func(f *gatewayv2.WebClientFrame) { f.GetAgentRequestChunk().Data = nil }},
		{"metadata replacement", func(f *gatewayv2.WebClientFrame) { f.GetAgentRequestChunk().Request = textSaveMetadata(false) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := newTextSaveCollector(t)
			if _, err := c.collectTextSave(textSaveChunk("save", "agent", 3, 0, []byte("a"), textSaveMetadata(false))); err != nil {
				t.Fatal(err)
			}
			frame := textSaveChunk("save", "agent", 3, 1, []byte("bc"), nil)
			tc.mutate(frame)
			if out, err := c.collectTextSave(frame); err == nil || out != nil {
				t.Fatalf("invalid chunk accepted: %v, %v", out, err)
			}
		})
	}
}

func TestTextSaveBoundsAndUTF8(t *testing.T) {
	for _, tc := range []struct {
		name  string
		frame *gatewayv2.WebClientFrame
	}{
		{"aggregate", textSaveChunk("save", "agent", maxTextSaveBytes+1, 0, []byte("a"), textSaveMetadata(false))},
		{"frame", textSaveChunk("save", "agent", 2*maxTextSaveFrameBytes, 0, make([]byte, maxTextSaveFrameBytes), textSaveMetadata(false))},
		{"first offset", textSaveChunk("save", "agent", 2, 1, []byte("a"), textSaveMetadata(false))},
		{"missing metadata", textSaveChunk("save", "agent", 2, 0, []byte("a"), nil)},
		{"invalid utf8", textSaveChunk("save", "agent", 1, 0, []byte{0xff}, textSaveMetadata(false))},
		{"unknown operation", textSaveChunk("save", "agent", 1, 0, []byte("a"), &gatewayv2.GatewayEnvelope{Payload: &gatewayv2.GatewayEnvelope_FsDelete{FsDelete: &gatewayv2.FsDeleteRequest{Path: "file"}}})},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if out, err := newTextSaveCollector(t).collectTextSave(tc.frame); err == nil || out != nil {
				t.Fatalf("invalid save accepted: %v, %v", out, err)
			}
		})
	}
	metadata := textSaveMetadata(false)
	metadata.GetFsWriteText().Content = "must not be duplicated"
	if err := vetTextSaveMetadata(metadata); err == nil {
		t.Fatal("metadata contained content")
	}
	metadata.GetFsWriteText().Content = ""
	metadata.GetFsWriteText().Path = strings.Repeat("x", maxTextSaveMetadata)
	if err := vetTextSaveMetadata(metadata); err == nil {
		t.Fatal("oversized metadata accepted")
	}

	c := newTextSaveCollector(t)
	part := bytes.Repeat([]byte("x"), 512<<10)
	for offset := 0; offset < maxTextSaveBytes; offset += len(part) {
		var request *gatewayv2.GatewayEnvelope
		if offset == 0 {
			request = textSaveMetadata(false)
		}
		out, err := c.collectTextSave(textSaveChunk("save", "agent", maxTextSaveBytes, uint64(offset), part, request))
		if err != nil {
			t.Fatal(err)
		}
		if offset+len(part) == maxTextSaveBytes {
			if len(out.GetFsWriteText().GetContent()) != maxTextSaveBytes {
				t.Fatal("exactly 16 MiB did not assemble")
			}
		} else if out != nil {
			t.Fatal("partial content dispatched")
		}
	}
}

func TestTextSaveCancellationTimeoutAndDisconnectRelease(t *testing.T) {
	for _, action := range []string{"cancel", "timeout", "disconnect", "reject"} {
		t.Run(action, func(t *testing.T) {
			c := newTextSaveCollector(t)
			c.handleAgentRequestChunk(textSaveChunk("save", "agent", 3, 0, []byte("a"), textSaveMetadata(false)))
			<-c.core.Outbox // intermediate ACK, with no dispatch or destination write
			switch action {
			case "cancel":
				cancel := textSaveChunk("save", "agent", 0, 0, nil, nil)
				cancel.GetAgentRequestChunk().Cancel = true
				c.handleAgentRequestChunk(cancel)
			case "timeout":
				c.textSaveMu.Lock()
				c.textSave.timer.Reset(0)
				c.textSaveMu.Unlock()
				select {
				case <-c.core.CtrlOutbox:
				case <-time.After(time.Second):
					t.Fatal("timeout did not release upload")
				}
			case "disconnect":
				c.core.Close()
			case "reject":
				c.handleAgentRequestChunk(textSaveChunk("save", "agent", 3, 0, []byte("bc"), nil))
			}
			c.textSaveMu.Lock()
			retained := c.textSave != nil
			c.textSaveMu.Unlock()
			if retained {
				t.Fatal("upload retained after " + action)
			}
			if action != "disconnect" {
				if _, err := c.collectTextSave(textSaveChunk("next", "agent", 3, 0, []byte("a"), textSaveMetadata(false))); err != nil {
					t.Fatalf("slot was not reusable: %v", err)
				}
			} else if _, err := c.collectTextSave(textSaveChunk("next", "agent", 3, 0, []byte("a"), textSaveMetadata(false))); err == nil {
				t.Fatal("closed connection admitted upload")
			}
		})
	}
}
