package pbws

import (
	"encoding/json"
	"errors"
	"strings"
	"sync"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/protocol/shared"
	"github.com/liveagent/agent-gateway/internal/session"
	"github.com/liveagent/agent-gateway/internal/transport/wscore"
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
				if errors.Is(err, wscore.ErrWriteQueueFull) {
					// 重置帧走控制队列越过拥塞积压；客户端重同步后按 seq 去重在途旧事件。
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
	if err != nil {
		_ = c.sendLocalError(requestID, errorMessage(err))
		return
	}
	subKey := requestedAgentID + "\x00" + workdir

	events, cancel := c.sm.SubscribeWorkspaceActivity(resolvedAgentID, workdir)
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
	forward(c, c.sm.SubscribeHistorySync, func(event session.Tagged[*gatewayv2.HistorySyncEvent]) (*gatewayv2.WebServerFrame, bool) {
		return &gatewayv2.WebServerFrame{
			AgentId: event.AgentID,
			Payload: &gatewayv2.WebServerFrame_HistoryEvent{HistoryEvent: event.Event},
		}, true
	}, "history_event")

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
