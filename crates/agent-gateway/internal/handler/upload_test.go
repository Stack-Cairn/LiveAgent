package handler

import (
	"bytes"
	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/session"
	"google.golang.org/protobuf/proto"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestReadableUploadRejectsOversizedBatchesWithoutSending(t *testing.T) {
	for _, sizes := range [][]int{{17 << 20}, {9 << 20, 8 << 20}} {
		sm := session.NewManager()
		sess := session.NewAgentSession(session.AuthSnapshot{AgentID: "agent", SessionID: "upload"})
		sm.SetSession(sess)
		var body bytes.Buffer
		form := multipart.NewWriter(&body)
		_ = form.WriteField("workdir", "/workspace")
		for _, size := range sizes {
			file, err := form.CreateFormFile("files", "large.txt")
			if err != nil {
				t.Fatal(err)
			}
			_, _ = file.Write(bytes.Repeat([]byte("x"), size))
		}
		_ = form.Close()
		req := httptest.NewRequest("POST", "/api/files/import?agent_id=agent", &body)
		req.Header.Set("Content-Type", form.FormDataContentType())
		result := httptest.NewRecorder()
		ImportReadableFiles(sm, time.Second)(result, req)
		if result.Code != http.StatusRequestEntityTooLarge {
			t.Fatalf("status=%d body=%s", result.Code, result.Body.String())
		}
		select {
		case <-sess.Outbound():
			t.Fatal("oversized upload reached desktop connection")
		default:
		}
		if !sm.IsOnline("agent") {
			t.Fatal("rejection disconnected the agent")
		}
		sm.ClearSession(sess)
	}
}

func TestReadableUploadBelowTransferLimitStillImports(t *testing.T) {
	sm := session.NewManager()
	sess := session.NewAgentSession(session.AuthSnapshot{AgentID: "agent", SessionID: "upload"})
	sm.SetSession(sess)
	defer sm.ClearSession(sess)
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	_ = form.WriteField("workdir", "/workspace")
	file, _ := form.CreateFormFile("files", "valid.txt")
	_, _ = file.Write(bytes.Repeat([]byte("x"), 15<<20))
	_ = form.Close()
	req := httptest.NewRequest("POST", "/api/files/import?agent_id=agent", &body)
	req.Header.Set("Content-Type", form.FormDataContentType())
	result := httptest.NewRecorder()
	done := make(chan struct{})
	go func() { ImportReadableFiles(sm, time.Second*5)(result, req); close(done) }()
	select {
	case out := <-sess.Outbound():
		frame := &gatewayv2.AgentServerFrame{Payload: &gatewayv2.AgentServerFrame_Envelope{Envelope: out.GatewayEnvelope}}
		if proto.Size(frame) > maxReadableUploadFrameBytes {
			t.Error("envelope exceeds desktop frame limit")
		}
		out.Ack(nil)
		sm.DispatchFromAgentForSession(sess, &gatewayv2.AgentEnvelope{RequestId: out.GetRequestId(), Payload: &gatewayv2.AgentEnvelope_UploadReadableFilesResp{UploadReadableFilesResp: &gatewayv2.UploadReadableFilesResponse{}}})
	case <-time.After(time.Second * 5):
		t.Fatal("no upload envelope")
	}
	<-done
	if result.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", result.Code, result.Body.String())
	}
}
