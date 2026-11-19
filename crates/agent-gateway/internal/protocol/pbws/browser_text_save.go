package pbws

import (
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"google.golang.org/protobuf/proto"
)

const (
	maxTextSaveBytes      = 16 << 20
	maxTextSaveFrameBytes = 1 << 20
	maxTextSaveMetadata   = 64 << 10
	textSaveTimeout       = 60 * time.Second
)

// Owned by one authenticated browser connection, including while dispatch is
// pending. A second transfer cannot multiply the socket's assembled-save budget.
type browserTextSave struct {
	requestID  string
	agentID    string
	total      uint64
	request    *gatewayv2.GatewayEnvelope
	content    []byte
	timer      *time.Timer
	dispatched bool
}

func (c *browserConn) releaseTextSaveLocked() {
	if c.textSave != nil && c.textSave.timer != nil {
		c.textSave.timer.Stop()
	}
	c.textSave = nil
}

func (c *browserConn) releaseTextSave() {
	c.textSaveMu.Lock()
	defer c.textSaveMu.Unlock()
	c.releaseTextSaveLocked()
}

// Only the dispatch owning this exact request may release its slot. Release
// before queueing the terminal response so a client that immediately starts its
// next save cannot race a deferred cleanup of the previous dispatch.
func (c *browserConn) finishTextSaveRequest(request *gatewayv2.GatewayEnvelope) {
	c.textSaveMu.Lock()
	defer c.textSaveMu.Unlock()
	if c.textSave != nil && c.textSave.dispatched && c.textSave.request == request {
		c.releaseTextSaveLocked()
	}
}

func (c *browserConn) rejectTextSave(requestID, message string) {
	c.textSaveMu.Lock()
	if c.textSave != nil && c.textSave.requestID == requestID && !c.textSave.dispatched {
		c.releaseTextSaveLocked()
	}
	c.textSaveMu.Unlock()
	_ = c.sendLocalError(requestID, message)
}

func vetTextSaveMetadata(env *gatewayv2.GatewayEnvelope) error {
	if env == nil || proto.Size(env) > maxTextSaveMetadata {
		return errors.New("text save metadata exceeds 64 KiB limit")
	}
	switch {
	case env.GetFsWriteText() != nil:
		if env.GetFsWriteText().GetContent() == "" {
			return nil
		}
	case env.GetSftpRequest() != nil:
		req := env.GetSftpRequest()
		if req.GetAction() == "write_text" && req.GetContent() == "" {
			return nil
		}
	}
	return errors.New("text save chunks require fs.write_text or sftp.write_text with empty content")
}

// collectTextSave does not touch destinations or dispatch requests. Only the
// final, length-checked, valid UTF-8 content becomes a normal existing request.
func (c *browserConn) collectTextSave(frame *gatewayv2.WebClientFrame) (*gatewayv2.GatewayEnvelope, error) {
	c.textSaveMu.Lock()
	defer c.textSaveMu.Unlock()
	id, agentID := frame.GetRequestId(), frame.GetAgentId()
	chunk := frame.GetAgentRequestChunk()
	if strings.TrimSpace(id) == "" || len(id) > 256 || strings.TrimSpace(agentID) == "" || len(agentID) > 256 {
		return nil, errors.New("text save request_id and agent_id are required and limited to 256 bytes")
	}
	select {
	case <-c.done:
		return nil, errors.New("browser connection is closed")
	default:
	}
	if chunk == nil || proto.Size(frame) > maxTextSaveFrameBytes {
		return nil, errors.New("text save chunk exceeds 1 MiB frame limit")
	}
	if active := c.textSave; active != nil && (active.requestID != id || active.agentID != agentID || active.dispatched) {
		return nil, errors.New("another text save is in progress on this connection")
	}
	if chunk.GetCancel() {
		c.releaseTextSaveLocked()
		return nil, nil
	}
	if chunk.GetTotalBytes() == 0 || chunk.GetTotalBytes() > maxTextSaveBytes || len(chunk.GetData()) == 0 {
		return nil, errors.New("text save requires nonempty chunks and at most 16 MiB of content")
	}
	if c.textSave == nil {
		if chunk.GetOffset() != 0 {
			return nil, errors.New("text save must start at offset zero")
		}
		if err := vetTextSaveMetadata(chunk.GetRequest()); err != nil {
			return nil, err
		}
		save := &browserTextSave{
			requestID: id, agentID: agentID, total: chunk.GetTotalBytes(),
			request: proto.Clone(chunk.GetRequest()).(*gatewayv2.GatewayEnvelope),
			content: make([]byte, 0, int(chunk.GetTotalBytes())),
		}
		c.textSave = save
		save.timer = time.AfterFunc(textSaveTimeout, func() {
			c.textSaveMu.Lock()
			if c.textSave != save || save.dispatched {
				c.textSaveMu.Unlock()
				return
			}
			c.releaseTextSaveLocked()
			c.textSaveMu.Unlock()
			_ = c.sendLocalError(id, "text save upload timed out")
		})
	} else if chunk.GetRequest() != nil {
		return nil, errors.New("text save metadata may only be sent in the first chunk")
	}
	save := c.textSave
	if chunk.GetTotalBytes() != save.total || chunk.GetOffset() != uint64(len(save.content)) || uint64(len(chunk.GetData())) > save.total-uint64(len(save.content)) {
		return nil, errors.New("text save length or offset mismatch")
	}
	save.content = append(save.content, chunk.GetData()...)
	if uint64(len(save.content)) != save.total {
		return nil, nil
	}
	if !utf8.Valid(save.content) {
		return nil, errors.New("text save content must be valid UTF-8")
	}
	content := string(save.content)
	if write := save.request.GetFsWriteText(); write != nil {
		write.Content = content
	} else {
		save.request.GetSftpRequest().Content = content
	}
	save.content = nil
	save.dispatched = true
	save.timer.Stop()
	return save.request, nil
}

func (c *browserConn) handleAgentRequestChunk(frame *gatewayv2.WebClientFrame) {
	requestID, agentID := frame.GetRequestId(), frame.GetAgentId()
	env, err := c.collectTextSave(frame)
	if err != nil {
		c.rejectTextSave(requestID, err.Error())
		return
	}
	if env == nil {
		_ = c.sendAck(requestID)
		return
	}
	// Keep the transfer slot until normal dispatch (including conflict response)
	// completes. Acquiring here also bounds the assembled requests in goroutines.
	if !c.dispatchLimiter.TryAcquire() {
		c.releaseTextSave()
		_ = c.sendLocalError(requestID, "too many concurrent requests")
		return
	}
	go func() {
		defer c.dispatchLimiter.Release()
		defer c.finishTextSaveRequest(env)
		c.handleAgentRequest(requestID, agentID, env)
	}()
}
