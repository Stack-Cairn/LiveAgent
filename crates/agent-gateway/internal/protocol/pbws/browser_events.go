package pbws

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"time"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/protocol/shared"
	"github.com/liveagent/agent-gateway/internal/session"
	"github.com/liveagent/agent-gateway/internal/transport/wscore"
	"google.golang.org/protobuf/proto"
)

// 浏览器连接的订阅生命周期、九路广播转发与连接后快照回放：
// 广播帧可掉（errWriteQueueFull 跳过继续），chat 会话流掉帧则发订阅重置信号让客户端按
// after_seq 断点续传。

// workspaceSubscription 是一个 workdir 的活动订阅。
type workspaceSubscription struct {
	cancel func()
	done   chan struct{}
	once   sync.Once
}

type historyRecoveryLatch struct {
	sourceID   string
	generation string
	token      string
	cutSeq     uint64
	snapshot   *gatewayv2.HistorySyncSnapshot
	createdAt  time.Time
}

func newHistoryResyncToken() string {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "history-resync-unavailable"
	}
	return hex.EncodeToString(value[:])
}

func (c *browserConn) latchHistoryRecovery(agentID string, status *gatewayv2.HistorySyncStatus) *gatewayv2.HistorySyncStatus {
	status = proto.Clone(status).(*gatewayv2.HistorySyncStatus)
	if !status.GetNeedsResync() {
		return status
	}
	c.historyRecoveryMu.Lock()
	if current, ok := c.historyRecovery[agentID]; ok &&
		current.sourceID == status.GetSourceId() && current.generation == status.GetGeneration() &&
		status.GetLatestDeliverySeq() <= current.cutSeq && time.Since(current.createdAt) <= 60*time.Second {
		status.ResyncToken = current.token
		c.historyRecoveryMu.Unlock()
		return status
	}
	latch := historyRecoveryLatch{
		sourceID:   status.GetSourceId(),
		generation: status.GetGeneration(),
		token:      newHistoryResyncToken(),
		cutSeq:     status.GetLatestDeliverySeq(),
		createdAt:  time.Now(),
	}
	if c.historyRecovery == nil {
		c.historyRecovery = make(map[string]historyRecoveryLatch)
	}
	c.historyRecovery[agentID] = latch
	c.historyRecoveryMu.Unlock()
	status.ResyncToken = latch.token
	return status
}

func (s *workspaceSubscription) close() {
	s.once.Do(func() {
		close(s.done)
		s.cancel()
	})
}

// releaseSubscriptions 由 core 关闭回调（恰好一次），释放 chat/workspace 订阅；
// 九路广播转发器各自监听 done 退出并 defer cleanup。
func (c *browserConn) releaseSubscriptions() {
	c.chatStreamsMu.Lock()
	for subKey, cancel := range c.chatStreams {
		cancel()
		delete(c.chatStreams, subKey)
	}
	c.chatStreamsMu.Unlock()

	c.workspaceSubsMu.Lock()
	for workdir, sub := range c.workspaceSubs {
		sub.close()
		delete(c.workspaceSubs, workdir)
	}
	c.workspaceSubsMu.Unlock()
}

// ---------------------------------------------------------------------------
// chat 会话流订阅
// ---------------------------------------------------------------------------

// handleChatSubscribe 处理 chat.subscribe（读循环内联执行以保帧序）。
func (c *browserConn) handleChatSubscribe(requestID, agentID string, req *gatewayv2.ChatSubscribeRequest) {
	agentID = strings.TrimSpace(agentID)
	conversationID := strings.TrimSpace(req.GetConversationId())
	if conversationID == "" {
		_ = c.sendLocalError(requestID, "conversation_id is required")
		return
	}

	sub := c.sm.SubscribeConversationStream(agentID, conversationID, req.GetAfterSeq(), req.GetStreamEpoch())
	if sub == nil {
		_ = c.sendLocalError(requestID, "agent_id and conversation_id are required")
		return
	}
	subKey := agentID + "\x00" + conversationID

	events := make([][]byte, 0, len(sub.Events))
	for _, event := range sub.Events {
		payload, err := json.Marshal(event.Payload)
		if err != nil {
			continue
		}
		events = append(events, payload)
	}
	result := &gatewayv2.ChatSubscribeResult{
		ConversationId: sub.ConversationID,
		StreamEpoch:    sub.StreamEpoch,
		LatestSeq:      sub.LatestSeq,
		Reset_:         sub.Reset,
		Activity:       chatRunActivity(sub.Activity),
		Snapshot:       chatRunSnapshot(sub.Snapshot),
		EventsJson:     events,
	}

	// 先登记（替换同会话旧订阅）再应答，避免回放边界之后发布的事件被漏。
	c.chatStreamsMu.Lock()
	if c.chatStreams == nil {
		c.chatStreams = make(map[string]func())
	}
	if previous := c.chatStreams[subKey]; previous != nil {
		previous()
	}
	c.chatStreams[subKey] = sub.Cleanup
	c.chatStreamsMu.Unlock()

	if err := c.send(wscore.FrameResponse, "chat_subscribed", &gatewayv2.WebServerFrame{
		RequestId: requestID,
		AgentId:   sub.AgentID,
		Payload:   &gatewayv2.WebServerFrame_ChatSubscribed{ChatSubscribed: result},
	}); err != nil {
		sub.Cleanup()
		c.chatStreamsMu.Lock()
		// Cleanup 幂等：仅当仍指向本次订阅时移除登记。
		delete(c.chatStreams, subKey)
		c.chatStreamsMu.Unlock()
		// 被掉帧的订阅响应会让客户端干等到超时且无人重订阅；控制队列上的重置信号重新武装其恢复循环。
		if errors.Is(err, wscore.ErrWriteQueueFull) {
			c.sendSubscriptionResetOrClose(sub.AgentID, conversationID)
		}
		return
	}

	go c.forwardConversationEvents(sub.AgentID, conversationID, sub)
}

// handleChatUnsubscribe 处理 chat.unsubscribe。
func (c *browserConn) handleChatUnsubscribe(requestID, agentID string, req *gatewayv2.ChatUnsubscribeRequest) {
	agentID = strings.TrimSpace(agentID)
	conversationID := strings.TrimSpace(req.GetConversationId())
	if conversationID == "" {
		_ = c.sendLocalError(requestID, "conversation_id is required")
		return
	}
	subKey := agentID + "\x00" + conversationID

	c.chatStreamsMu.Lock()
	if cancel := c.chatStreams[subKey]; cancel != nil {
		cancel()
		delete(c.chatStreams, subKey)
	}
	c.chatStreamsMu.Unlock()

	_ = c.sendAck(requestID)
}

func (c *browserConn) sendAck(requestID string) error {
	return c.send(wscore.FrameResponse, "ack", &gatewayv2.WebServerFrame{
		RequestId: requestID,
		Payload:   &gatewayv2.WebServerFrame_Ack{Ack: &gatewayv2.AckResult{Ok: true}},
	})
}

// forwardConversationEvents 推送订阅后的实时会话事件；订阅通道溢出或写队列持续拥塞时
// 通知客户端重订阅（after_seq 从缓冲重放缺口），拥塞只牺牲该订阅、不牺牲连接。
func (c *browserConn) forwardConversationEvents(
	agentID string,
	conversationID string,
	sub *session.ConversationSubscription,
) {
	defer sub.Cleanup()
	for {
		select {
		case <-c.done:
			return
		case event, ok := <-sub.EventCh:
			if !ok {
				if sub.Overflowed() {
					c.sendSubscriptionResetOrClose(agentID, conversationID)
				}
				return
			}
			payload, err := json.Marshal(event.Payload)
			if err != nil {
				continue
			}
			if err := c.send(wscore.FrameData, "chat_event", &gatewayv2.WebServerFrame{
				AgentId: agentID,
				Payload: &gatewayv2.WebServerFrame_ChatEvent{
					ChatEvent: &gatewayv2.ChatStreamEvent{
						ConversationId: conversationID,
						Seq:            event.Seq,
						PayloadJson:    payload,
					},
				},
			}); err != nil {
				if errors.Is(err, wscore.ErrWriteQueueFull) || errors.Is(err, wscore.ErrWriteFrameTooLarge) {
					// 重置帧走控制队列越过拥塞积压；客户端重同步后按 seq 去重在途旧事件。
					// 超限单帧同样只牺牲该订阅：重订阅回放/快照与 history 收敛负责补内容。
					c.sendSubscriptionResetOrClose(agentID, conversationID)
				}
				return
			}
		}
	}
}

// sendSubscriptionResetOrClose 送出恢复被掉订阅的唯一信号；连控制队列都容不下时关闭连接，
// 重连后的重订阅（after_seq）是仅剩的不可丢路径。
func (c *browserConn) sendSubscriptionResetOrClose(agentID string, conversationID string) {
	if err := c.send(wscore.FrameControl, "chat_subscription_reset", &gatewayv2.WebServerFrame{
		AgentId: agentID,
		Payload: &gatewayv2.WebServerFrame_ChatSubscriptionReset{
			ChatSubscriptionReset: &gatewayv2.ChatSubscriptionReset{ConversationId: conversationID},
		},
	}); err != nil {
		c.core.Close()
	}
}

// ---------------------------------------------------------------------------
// workspace 活动订阅
// ---------------------------------------------------------------------------

// handleWorkspaceSubscribe 处理 workspace.subscribe（读循环内联）。订阅按
// (agent, workdir) 作用域；分派层已保证 agent_id 非空。
func (c *browserConn) handleWorkspaceSubscribe(requestID, agentID string, req *gatewayv2.WorkspaceSubscribeRequest) {
	workdir := strings.TrimSpace(req.GetWorkdir())
	if workdir == "" {
		_ = c.sendLocalError(requestID, "workdir is required")
		return
	}
	requestedAgentID := strings.TrimSpace(agentID)
	resolvedAgentID, err := c.sm.ResolveAgentID(requestedAgentID)
	var ownerCleanup func()
	if err != nil && errors.Is(err, session.ErrAgentOffline) {
		resolvedAgentID, _, ownerCleanup, err = c.sm.EnsureLocalWorkspaceActivityOwner(requestedAgentID, workdir)
	}
	if err != nil {
		_ = c.sendLocalError(requestID, errorMessage(err))
		return
	}
	subKey := requestedAgentID + "\x00" + workdir

	events, cancel := c.sm.SubscribeWorkspaceActivity(resolvedAgentID, workdir)
	if ownerCleanup != nil {
		baseCancel := cancel
		cancel = func() {
			baseCancel()
			ownerCleanup()
		}
	}
	sub := &workspaceSubscription{
		cancel: cancel,
		done:   make(chan struct{}),
	}

	c.workspaceSubsMu.Lock()
	if c.workspaceSubs == nil {
		c.workspaceSubs = make(map[string]*workspaceSubscription)
	}
	if previous := c.workspaceSubs[subKey]; previous != nil {
		previous.close()
	}
	c.workspaceSubs[subKey] = sub
	c.workspaceSubsMu.Unlock()

	if err := c.sendAck(requestID); err != nil {
		sub.close()
		c.workspaceSubsMu.Lock()
		if c.workspaceSubs[subKey] == sub {
			delete(c.workspaceSubs, subKey)
		}
		c.workspaceSubsMu.Unlock()
		return
	}

	go func() {
		for {
			select {
			case <-c.done:
				return
			case <-sub.done:
				return
			case event, ok := <-events:
				if !ok {
					return
				}
				if err := c.send(wscore.FrameData, "workspace_activity", &gatewayv2.WebServerFrame{
					AgentId: resolvedAgentID,
					Payload: &gatewayv2.WebServerFrame_WorkspaceActivity{WorkspaceActivity: event},
				}); err != nil {
					if errors.Is(err, wscore.ErrWriteQueueFull) {
						continue
					}
					return
				}
			}
		}
	}()
}

// handleWorkspaceUnsubscribe 处理 workspace.unsubscribe。
func (c *browserConn) handleWorkspaceUnsubscribe(requestID, agentID string, req *gatewayv2.WorkspaceUnsubscribeRequest) {
	subKey := strings.TrimSpace(agentID) + "\x00" + strings.TrimSpace(req.GetWorkdir())

	c.workspaceSubsMu.Lock()
	if sub := c.workspaceSubs[subKey]; sub != nil {
		sub.close()
		delete(c.workspaceSubs, subKey)
	}
	c.workspaceSubsMu.Unlock()

	_ = c.sendAck(requestID)
}

// ---------------------------------------------------------------------------
// 广播事件扇出与快照回放
// ---------------------------------------------------------------------------

// startEventForwarders 启动九路广播转发；
// 泛型 forward 统一可掉帧广播骨架，各路只提供订阅与帧构造。广播帧盖来源
// agent_id（服务端不过滤，客户端按活跃 Agent 过滤）；功能门控按来源 Agent 判定。
func (c *browserConn) startEventForwarders() {
	forward(c, c.sm.SubscribePlanningChanged, func(event session.Tagged[*gatewayv2.PlanningChanged]) (*gatewayv2.WebServerFrame, bool) {
		return &gatewayv2.WebServerFrame{AgentId: event.AgentID, Payload: &gatewayv2.WebServerFrame_PlanningChanged{PlanningChanged: event.Event}}, true
	}, "planning_changed")

	historySub := c.sm.SubscribeHistorySyncRecovery()
	c.historySyncAck = historySub.Acknowledge
	go c.forwardHistorySync(historySub)

	forward(c, c.sm.SubscribeSettingsSync, func(event session.Tagged[*gatewayv2.SettingsSyncEvent]) (*gatewayv2.WebServerFrame, bool) {
		return &gatewayv2.WebServerFrame{
			AgentId: event.AgentID,
			Payload: &gatewayv2.WebServerFrame_SettingsEvent{SettingsEvent: event.Event},
		}, true
	}, "settings_event")

	forward(c, c.sm.SubscribeTerminalEvents, func(event session.Tagged[*gatewayv2.TerminalEvent]) (*gatewayv2.WebServerFrame, bool) {
		if !shared.TerminalEventAllowed(c.sm.AgentView(event.AgentID), event.Event) || !c.terminalInterest.ShouldForward(event.Event) {
			return nil, false
		}
		return &gatewayv2.WebServerFrame{
			AgentId: event.AgentID,
			Payload: &gatewayv2.WebServerFrame_TerminalEvent{TerminalEvent: event.Event},
		}, true
	}, "terminal_event")

	forward(c, c.sm.SubscribeSftpEvents, func(event session.Tagged[*gatewayv2.SftpEvent]) (*gatewayv2.WebServerFrame, bool) {
		if !c.sm.WebSshTerminalEnabled(event.AgentID) {
			return nil, false
		}
		return &gatewayv2.WebServerFrame{
			AgentId: event.AgentID,
			Payload: &gatewayv2.WebServerFrame_SftpEvent{SftpEvent: event.Event},
		}, true
	}, "sftp_event")

	forward(c, c.sm.SubscribeChatQueueEvents, func(event session.Tagged[*gatewayv2.ChatQueueEvent]) (*gatewayv2.WebServerFrame, bool) {
		return &gatewayv2.WebServerFrame{
			AgentId: event.AgentID,
			Payload: &gatewayv2.WebServerFrame_ChatQueueEvent{ChatQueueEvent: event.Event},
		}, true
	}, "chat_queue_event")

	forward(c, c.sm.SubscribeChatActivity, func(event session.ConversationActivityEvent) (*gatewayv2.WebServerFrame, bool) {
		return &gatewayv2.WebServerFrame{
			AgentId: event.AgentID,
			Payload: &gatewayv2.WebServerFrame_ChatActivity{ChatActivity: chatActivityEvent(event)},
		}, true
	}, "chat_activity")

	forward(c, c.sm.SubscribeTunnelState, func(event session.Tagged[*gatewayv2.TunnelStateSnapshot]) (*gatewayv2.WebServerFrame, bool) {
		return &gatewayv2.WebServerFrame{
			AgentId: event.AgentID,
			Payload: &gatewayv2.WebServerFrame_TunnelState{TunnelState: event.Event},
		}, true
	}, "tunnel_state")

	forward(c, c.sm.SubscribeManagedProcessState, func(event session.Tagged[*gatewayv2.ManagedProcessSnapshot]) (*gatewayv2.WebServerFrame, bool) {
		return &gatewayv2.WebServerFrame{
			AgentId: event.AgentID,
			Payload: &gatewayv2.WebServerFrame_ProcessState{ProcessState: event.Event},
		}, true
	}, "process_state")

	forward(c, c.sm.SubscribeStatus, func(status session.Tagged[session.Status]) (*gatewayv2.WebServerFrame, bool) {
		return &gatewayv2.WebServerFrame{
			AgentId: status.AgentID,
			Payload: &gatewayv2.WebServerFrame_Status{Status: statusEvent(status.Event)},
		}, true
	}, "status")
}

func (c *browserConn) forwardHistorySync(sub *session.HistorySyncSubscription) {
	defer sub.Cleanup()
	for {
		select {
		case <-c.done:
			return
		case event := <-sub.Events:
			if err := c.send(wscore.FrameData, "history_event", &gatewayv2.WebServerFrame{
				AgentId: event.AgentID,
				Payload: &gatewayv2.WebServerFrame_HistoryEvent{HistoryEvent: event.Event},
			}); err != nil {
				if errors.Is(err, wscore.ErrWriteQueueFull) {
					status := c.latchHistoryRecovery(event.AgentID, &gatewayv2.HistorySyncStatus{
						SourceId:          event.Event.GetSourceId(),
						Generation:        event.Event.GetGeneration(),
						LatestDeliverySeq: event.Event.GetDeliverySeq(),
						Available:         true,
						NeedsResync:       true,
					})
					if sendErr := c.send(wscore.FrameControl, "history_sync_status", &gatewayv2.WebServerFrame{
						AgentId: event.AgentID,
						Payload: &gatewayv2.WebServerFrame_HistorySyncStatus{HistorySyncStatus: status},
					}); sendErr != nil {
						c.core.Close()
						return
					}
					continue
				}
				return
			}
		case status := <-sub.Status:
			status.Event = c.latchHistoryRecovery(status.AgentID, status.Event)
			if err := c.send(wscore.FrameControl, "history_sync_status", &gatewayv2.WebServerFrame{
				AgentId: status.AgentID,
				Payload: &gatewayv2.WebServerFrame_HistorySyncStatus{HistorySyncStatus: status.Event},
			}); err != nil {
				// Recovery control cannot be allowed to disappear behind the same
				// congested queue as the data that triggered it.
				c.core.Close()
				return
			}
		}
	}
}

func (c *browserConn) handleHistoryResync(requestID, agentID string, request *gatewayv2.HistoryResyncRequest) {
	token := strings.TrimSpace(request.GetResyncToken())
	c.historyRecoveryMu.Lock()
	latch, latched := c.historyRecovery[agentID]
	if latched && time.Since(latch.createdAt) > 60*time.Second {
		delete(c.historyRecovery, agentID)
		latched = false
	}
	c.historyRecoveryMu.Unlock()
	if !latched && token == "" {
		if current, ok := c.sm.HistorySyncSnapshot(agentID, ""); ok {
			status := c.latchHistoryRecovery(agentID, &gatewayv2.HistorySyncStatus{
				SourceId: current.GetSourceId(), Generation: current.GetGeneration(),
				LatestDeliverySeq: current.GetCutDeliverySeq(), Available: true, NeedsResync: true,
			})
			token = status.GetResyncToken()
			c.historyRecoveryMu.Lock()
			latch, latched = c.historyRecovery[agentID]
			c.historyRecoveryMu.Unlock()
		}
	}
	if !latched || token == "" || token != latch.token {
		_ = c.sendLocalError(requestID, "stale history resync token")
		return
	}
	if latch.snapshot == nil {
		current, ok := c.sm.HistorySyncSnapshot(agentID, token)
		if !ok {
			_ = c.sendLocalError(requestID, "history synchronization snapshot is unavailable")
			return
		}
		c.historyRecoveryMu.Lock()
		latest := c.historyRecovery[agentID]
		if latest.token != token {
			c.historyRecoveryMu.Unlock()
			_ = c.sendLocalError(requestID, "stale history resync token")
			return
		}
		latest.snapshot = proto.Clone(current).(*gatewayv2.HistorySyncSnapshot)
		latest.cutSeq = current.GetCutDeliverySeq()
		c.historyRecovery[agentID] = latest
		latch = latest
		c.historyRecoveryMu.Unlock()
	}
	snapshot, err := pageHistorySnapshot(latch.snapshot, request.GetOffset(), request.GetLimit())
	if err != nil {
		_ = c.sendLocalError(requestID, err.Error())
		return
	}
	if err := c.send(wscore.FrameResponse, "history_sync_snapshot", &gatewayv2.WebServerFrame{
		RequestId: requestID,
		AgentId:   agentID,
		Payload: &gatewayv2.WebServerFrame_HistorySyncSnapshot{
			HistorySyncSnapshot: snapshot,
		},
	}); err != nil {
		c.core.Close()
	}
}

func pageHistorySnapshot(snapshot *gatewayv2.HistorySyncSnapshot, offset, requestedLimit uint32) (*gatewayv2.HistorySyncSnapshot, error) {
	total := uint32(len(snapshot.GetConversations()))
	limit := requestedLimit
	if limit == 0 || limit > 500 {
		limit = 500
	}
	if offset > total {
		offset = total
	}
	newPage := func(end uint32) *gatewayv2.HistorySyncSnapshot {
		out := &gatewayv2.HistorySyncSnapshot{
			SourceId: snapshot.GetSourceId(), Generation: snapshot.GetGeneration(),
			CutDeliverySeq: snapshot.GetCutDeliverySeq(), ResyncToken: snapshot.GetResyncToken(),
			Offset: offset, TotalCount: total,
		}
		out.Conversations = make([]*gatewayv2.ConversationSummary, 0, end-offset)
		for _, summary := range snapshot.Conversations[offset:end] {
			out.Conversations = append(out.Conversations, proto.Clone(summary).(*gatewayv2.ConversationSummary))
		}
		if offset == 0 {
			out.Workdirs = make([]*gatewayv2.HistoryWorkdirSummary, 0, len(snapshot.Workdirs))
			for _, item := range snapshot.Workdirs {
				out.Workdirs = append(out.Workdirs, proto.Clone(item).(*gatewayv2.HistoryWorkdirSummary))
			}
		}
		return out
	}
	var end uint32
	var out *gatewayv2.HistorySyncSnapshot
	for {
		end = offset + limit
		if end > total {
			end = total
		}
		out = newPage(end)
		if proto.Size(out) <= 8<<20 {
			break
		}
		if limit <= 1 {
			return nil, errors.New("history synchronization snapshot entry exceeds frame budget")
		}
		limit /= 2
	}
	if end < total {
		out.NextOffset = end
	} else {
		out.NextOffset = 0
	}
	return out, nil
}

func (c *browserConn) handleHistoryResyncAck(requestID, agentID string, ack *gatewayv2.HistoryResyncAck) {
	if strings.TrimSpace(ack.GetSourceId()) == "" || strings.TrimSpace(ack.GetGeneration()) == "" {
		_ = c.sendLocalError(requestID, "history resync acknowledgement identity is required")
		return
	}
	// The authoritative snapshot is held by the manager, so acknowledging is
	// connection-local. A stale acknowledgement never mutates manager state.
	c.historyRecoveryMu.Lock()
	latch, ok := c.historyRecovery[agentID]
	if !ok || !historyResyncAckMatches(latch, ack, time.Now()) {
		if ok && time.Since(latch.createdAt) > 60*time.Second {
			delete(c.historyRecovery, agentID)
		}
		c.historyRecoveryMu.Unlock()
		_ = c.sendLocalError(requestID, "stale history resync acknowledgement")
		return
	}
	delete(c.historyRecovery, agentID)
	c.historyRecoveryMu.Unlock()
	if c.historySyncAck != nil {
		c.historySyncAck(agentID, ack.GetGeneration(), ack.GetAppliedDeliverySeq())
	}
	_ = c.sendAck(requestID)
}

func historyResyncAckMatches(latch historyRecoveryLatch, ack *gatewayv2.HistoryResyncAck, now time.Time) bool {
	return ack != nil && now.Sub(latch.createdAt) <= 60*time.Second &&
		latch.token == ack.GetResyncToken() && latch.generation == ack.GetGeneration() &&
		latch.sourceID == ack.GetSourceId() && ack.GetAppliedDeliverySeq() >= latch.cutSeq
}

// forward 是可掉帧广播转发的共用骨架：subscribe 建立订阅（cleanup 随 goroutine 退出执行），
// build 过滤并构造帧；掉帧跳过继续，其他写错误结束转发。
func forward[T any](
	c *browserConn,
	subscribe func() (<-chan T, func()),
	build func(T) (*gatewayv2.WebServerFrame, bool),
	kind string,
) {
	events, cleanup := subscribe()
	go func() {
		defer cleanup()
		for {
			select {
			case <-c.done:
				return
			case event, ok := <-events:
				if !ok {
					return
				}
				frame, send := build(event)
				if !send {
					continue
				}
				if err := c.send(wscore.FrameData, kind, frame); err != nil {
					if errors.Is(err, wscore.ErrWriteQueueFull) {
						continue
					}
					return
				}
			}
		}
	}()
}

// replaySnapshots 在鉴权后把当前状态画到新连接上，免去首轮轮询。
// 逐个在线 Agent 回放各自快照并打标；每个在线 Agent 补发一条状态帧（目录渲染），
// 所有回放帧均携带明确来源，不再发送无标的单 Agent 兼容帧。
func (c *browserConn) replaySnapshots() {
	for _, agentID := range c.sm.ConnectedAgentIDs() {
		view := c.sm.AgentView(agentID)
		// 终端会话快照：以 created 事件逐条回放（按各 Agent 的门控独立判定）。
		if shared.TerminalFeaturesEnabled(view) {
			for _, terminalSession := range view.TerminalSessionSnapshot("") {
				if !shared.TerminalSessionAllowed(view, terminalSession) {
					continue
				}
				if err := c.send(wscore.FrameData, "terminal_event", &gatewayv2.WebServerFrame{
					AgentId: agentID,
					Payload: &gatewayv2.WebServerFrame_TerminalEvent{
						TerminalEvent: &gatewayv2.TerminalEvent{
							Kind:           "created",
							SessionId:      terminalSession.GetId(),
							ProjectPathKey: terminalSession.GetProjectPathKey(),
							Session:        terminalSession,
						},
					},
				}); err != nil {
					return
				}
			}
		}
		// 进程快照按 Agent 回放。
		if processSnapshot := c.sm.ManagedProcessSnapshotCached(agentID); processSnapshot != nil {
			_ = c.send(wscore.FrameData, "process_state", &gatewayv2.WebServerFrame{
				AgentId: agentID,
				Payload: &gatewayv2.WebServerFrame_ProcessState{ProcessState: processSnapshot},
			})
		}
		// 每 Agent 一条状态帧：新客户端由此渲染 Agent 目录，无需先发 agent_list。
		agentStatus := c.sm.Status(agentID)
		_ = c.send(wscore.FrameData, "status", &gatewayv2.WebServerFrame{
			AgentId: agentID,
			Payload: &gatewayv2.WebServerFrame_Status{Status: statusEvent(agentStatus)},
		})
		if snapshot, ok := c.sm.HistorySyncSnapshot(agentID, ""); ok {
			status := c.latchHistoryRecovery(agentID, &gatewayv2.HistorySyncStatus{
				SourceId:          snapshot.GetSourceId(),
				Generation:        snapshot.GetGeneration(),
				LatestDeliverySeq: snapshot.GetCutDeliverySeq(),
				Available:         true,
				NeedsResync:       true,
			})
			_ = c.send(wscore.FrameData, "history_sync_status", &gatewayv2.WebServerFrame{
				AgentId: agentID,
				Payload: &gatewayv2.WebServerFrame_HistorySyncStatus{
					HistorySyncStatus: status,
				},
			})
		}
	}

	// 每个已登记 Agent 回放自己的隧道快照并打标；离线 Agent 也保留其隧道目录。
	for _, status := range c.sm.AgentStatuses() {
		agentID := strings.TrimSpace(status.AgentID)
		if agentID == "" {
			continue
		}
		_ = c.send(wscore.FrameData, "tunnel_state", &gatewayv2.WebServerFrame{
			AgentId: agentID,
			Payload: &gatewayv2.WebServerFrame_TunnelState{
				TunnelState: c.sm.TunnelStateSnapshot(agentID),
			},
		})
	}
}
