package pbws

import (
	"context"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/liveagent/agent-gateway/internal/chatcmd"
	"github.com/liveagent/agent-gateway/internal/config"
	"github.com/liveagent/agent-gateway/internal/handler"
	"github.com/liveagent/agent-gateway/internal/kbrain"
	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/session"
	"github.com/liveagent/agent-gateway/internal/transport/wscore"
)

// 由网关状态直接应答（或由网关编排）的本地操作；chat 编排复用 internal/chatcmd。

// handleStatusGet 处理指定 Agent 的 status.get。
func (c *browserConn) handleStatusGet(requestID, agentID string) {
	if c.srv.kbrainRelay != nil && agentID == c.srv.kbrainTargetID {
		_ = c.send(wscore.FrameResponse, "status", &gatewayv2.WebServerFrame{RequestId: requestID, AgentId: agentID, Payload: &gatewayv2.WebServerFrame_Status{Status: &gatewayv2.StatusEvent{Online: true, AgentReady: true, ChatRuntimeReady: true, AgentId: agentID}}})
		return
	}
	status := c.sm.Status(agentID)
	_ = c.send(wscore.FrameResponse, "status", &gatewayv2.WebServerFrame{
		RequestId: requestID,
		AgentId:   status.AgentID,
		Payload: &gatewayv2.WebServerFrame_Status{
			Status: statusEvent(status),
		},
	})
}

// handleAgentList 返回全部已登记 Agent 的状态目录（含离线项）；持久化目录补全
// 网关重启后尚未重连的 Agent，供 webui 渲染完整列表。
func (c *browserConn) handleAgentList(requestID string) {
	registered, err := c.srv.tokens.Registered()
	if err != nil {
		_ = c.sendLocalError(requestID, "agent directory unavailable")
		return
	}
	registeredByID := make(map[string]string, len(registered))
	for _, entry := range registered {
		registeredByID[entry.AgentID] = entry.Name
	}

	statuses := c.sm.AgentStatuses()
	known := make(map[string]bool, len(statuses))
	agents := make([]*gatewayv2.StatusEvent, 0, len(statuses)+len(registered))
	for _, status := range statuses {
		known[status.AgentID] = true
		event := statusEvent(status)
		event.Name = registeredByID[status.AgentID]
		agents = append(agents, event)
	}
	for _, entry := range registered {
		if !known[entry.AgentID] {
			agents = append(agents, &gatewayv2.StatusEvent{AgentId: entry.AgentID, Name: entry.Name})
		}
	}
	if c.srv.kbrainRelay != nil {
		for _, agent := range agents {
			if agent.GetAgentId() == c.srv.kbrainTargetID {
				agent.Online = true
				agent.AgentReady = true
				agent.ChatRuntimeReady = true
				agent.Name = "K-brain"
			}
		}

		found := false
		for _, agent := range agents {
			if agent.GetAgentId() == c.srv.kbrainTargetID {
				found = true
				break
			}
		}
		if !found {
			agents = append(agents, &gatewayv2.StatusEvent{AgentId: c.srv.kbrainTargetID, Name: "K-brain", Online: true, AgentReady: true, ChatRuntimeReady: true})
		}
	}
	sort.Slice(agents, func(i, j int) bool { return agents[i].GetAgentId() < agents[j].GetAgentId() })
	_ = c.send(wscore.FrameResponse, "agent_list", &gatewayv2.WebServerFrame{
		RequestId: requestID,
		Payload: &gatewayv2.WebServerFrame_AgentList{
			AgentList: &gatewayv2.AgentListResult{Agents: agents},
		},
	})
}

// handleChatPrepare 处理 chat.prepare：探活/唤醒目标桌面运行时后返回与 status_get
// 同构的状态（客户端共享一个状态归一化器）。
func (c *browserConn) handleChatPrepare(requestID, agentID string, _ *gatewayv2.ChatPrepareRequest) {
	if c.srv.kbrainRelay != nil && agentID == c.srv.kbrainTargetID {
		_ = c.send(wscore.FrameControl, "status", &gatewayv2.WebServerFrame{
			RequestId: requestID,
			AgentId:   agentID,
			Payload: &gatewayv2.WebServerFrame_Status{Status: &gatewayv2.StatusEvent{
				Online: true, AgentReady: true, ChatRuntimeReady: true, AgentId: agentID,
			}},
		})
		return
	}
	if c.sm.IsOnline(agentID) && !c.sm.ChatIngressV1Ready(agentID) {
		status := c.sm.Status(agentID)
		_ = c.send(wscore.FrameControl, "status", &gatewayv2.WebServerFrame{
			RequestId: requestID,
			AgentId:   status.AgentID,
			Payload: &gatewayv2.WebServerFrame_Status{
				Status: statusEvent(status),
			},
		})
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), chatcmd.PrepareTimeout(c.cfg))
	defer cancel()
	if err := chatcmd.ProbeRuntime(ctx, c.sm, agentID); err != nil {
		_ = c.sendLocalError(requestID, errorMessage(err))
		return
	}
	status := c.sm.Status(agentID)
	// 响应走控制队列，避免被数据积压饿死。
	_ = c.send(wscore.FrameControl, "status", &gatewayv2.WebServerFrame{
		RequestId: requestID,
		AgentId:   status.AgentID,
		Payload: &gatewayv2.WebServerFrame_Status{
			Status: statusEvent(status),
		},
	})
}

// handleChatActivities 处理 chat.activities：仅由网关状态应答，桌面端离线时亦可用。
func (c *browserConn) handleChatActivities(requestID string) {
	activities := c.sm.ActiveConversationActivities()
	running := make([]*gatewayv2.ChatRunActivity, 0, len(activities))
	for _, activity := range activities {
		running = append(running, chatRunActivityListItem(activity))
	}
	_ = c.send(wscore.FrameResponse, "chat_activities", &gatewayv2.WebServerFrame{
		RequestId: requestID,
		Payload: &gatewayv2.WebServerFrame_ChatActivities{
			ChatActivities: &gatewayv2.ChatActivitiesResult{RunningConversations: running},
		},
	})
}

// handleChatCommand 处理 chat.command：submit / edit_resend 经网关编排
// （去重、接受即回执、命令更新观察、启动看门狗、投递），cancel 单独处理。
// agentID 是已由分派层校验过的显式目标 Agent。
func (c *browserConn) handleChatCommand(requestID, agentID string, cmd *gatewayv2.ChatCommandRequest) {
	commandType := strings.TrimSpace(cmd.GetType())
	body := chatcmd.RequestBodyFromProto(cmd.GetRequest())
	baseMessageRef := chatcmd.MessageRefFromProto(cmd.GetBaseMessageRef())

	switch commandType {
	case "chat.submit":
		baseMessageRef = nil
	case "chat.edit_resend":
		if baseMessageRef == nil {
			_ = c.sendLocalError(requestID, "base_message_ref is required")
			return
		}
		if err := chatcmd.ValidateMessageRef(baseMessageRef); err != nil {
			_ = c.sendLocalError(requestID, err.Error())
			return
		}
	case "chat.cancel":
		c.handleChatCancel(requestID, agentID, cmd.GetCancel())
		return
	default:
		_ = c.sendLocalError(requestID, "unsupported chat command")
		return
	}

	if err := chatcmd.NormalizeRequestBody(&body); err != nil {
		_ = c.sendLocalError(requestID, err.Error())
		return
	}

	if existing, ok := c.sm.LookupChatCommand(agentID, body.ClientRequestID); ok {
		c.respondChatCommandDeduped(requestID, existing)
		return
	}

	if c.srv.kbrainRelay != nil && agentID == c.srv.kbrainTargetID {
		// 直连 K-brain 只支持提示词指令；/goal 需要桌面端的目标栏与续跑挂接。
		if body.GoalAction != "" {
			_ = c.sendLocalError(requestID, errComposerGoalUnsupported)
			return
		}
		c.handleKBrainChatCommand(requestID, agentID, body)
		return
	}
	if !c.sm.IsOnline(agentID) {
		_ = c.sendLocalError(requestID, "agent offline")
		return
	}
	if chatcmd.HasComposerCommand(body) &&
		!c.sm.SupportsCapability(agentID, gatewayv2.ComposerCommandsV1Capability) {
		_ = c.sendLocalError(requestID, errComposerCommandsUnsupported)
		return
	}
	if len(body.ReferencedConversations) > 0 &&
		!c.sm.SupportsCapability(agentID, gatewayv2.ConversationReferencesV1Capability) {
		_ = c.sendLocalError(
			requestID,
			session.ErrConversationReferencesProtocolIncompatible.Error(),
		)
		return
	}
	probeCtx, probeCancel := context.WithTimeout(
		context.Background(), chatcmd.PrepareTimeout(c.cfg),
	)
	probeErr := chatcmd.ProbeRuntimeForCommand(probeCtx, c.sm, agentID)
	probeCancel()
	if probeErr != nil {
		_ = c.sendLocalError(requestID, errorMessage(probeErr))
		return
	}

	runID := "chat-command-" + uuid.NewString()
	start := c.sm.StartChatCommand(
		agentID,
		runID,
		body.ConversationID,
		body.Workdir,
		body.ClientRequestID,
		chatcmd.BuildAcceptedCommandPayloads(body, baseMessageRef),
		chatcmd.HasComposerCommand(body),
	)
	if start.Deduped {
		c.respondChatCommandDeduped(requestID, start)
		return
	}
	updates, cleanupWatch := c.sm.WatchChatCommand(start.AgentID, start.RunID)

	_ = c.sendChatCommandAccepted(requestID, start)

	go c.forwardChatCommandUpdates(updates, cleanupWatch)
	go chatcmd.DispatchAcceptedCommand(
		context.Background(), c.cfg, c.sm, agentID, cleanupWatch, start, body, baseMessageRef, chatcmd.NewTraceID(),
	)
}

func (c *browserConn) handleKBrainChatCommand(requestID, agentID string, body handler.ChatRequestBody) {
	if body.ConversationID == "" {
		body.ConversationID = uuid.NewString()
	}
	runID := "kbrain-command-" + uuid.NewString()
	start := c.sm.StartChatCommand(agentID, runID, body.ConversationID, body.Workdir, body.ClientRequestID, chatcmd.BuildAcceptedCommandPayloads(body, nil), chatcmd.HasComposerCommand(body))
	if start.Deduped {
		c.respondChatCommandDeduped(requestID, start)
		return
	}
	if err := c.sendChatCommandAccepted(requestID, start); err != nil {
		return
	}
	updates, cleanup := c.sm.WatchChatCommand(agentID, runID)
	go c.forwardChatCommandUpdates(updates, cleanup)
	var model *kbrain.ModelRef
	if body.SelectedModel != nil {
		provider := strings.TrimSpace(body.SelectedModel.CustomProviderID)
		if provider == "" {
			provider = strings.TrimSpace(body.SelectedModel.ProviderType)
		}
		model = &kbrain.ModelRef{Provider: provider, Model: body.SelectedModel.Model}
	}
	options := kbrainOptions(body)
	callbacks := c.srv.kbrainCallbacks(start.AgentID)
	ready := make(chan struct{})
	onEvent, onControl := callbacks.OnEvent, callbacks.OnControl
	callbacks.OnEvent = func(runID string, event *gatewayv2.ChatEvent) {
		<-ready
		onEvent(runID, event)
	}
	callbacks.OnControl = func(runID string, control *gatewayv2.ChatControlEvent) {
		<-ready
		onControl(runID, control)
	}
	queued, err := c.srv.kbrainRelay.StartWithCWD(context.Background(), start.RunID, start.ConversationID, body.ClientRequestID, body.Workdir, kbrain.PromptRequest{Prompt: body.Message, PromptCommand: body.PromptCommand, Model: model, Options: options}, body.QueuePolicy, callbacks, chatcmd.HasComposerCommand(body))
	if err == nil && queued {
		// Settle the browser startup watchdog before a queued run can start.
		onControl(start.RunID, &gatewayv2.ChatControlEvent{RequestId: start.RunID, ConversationId: start.ConversationID, Type: "queued_in_gui"})
	}
	close(ready)
	if err != nil {
		code := "kbrain_relay_error"
		if strings.Contains(err.Error(), "already running") {
			code = "conversation_busy"
		}
		c.sm.FailChatCommand(agentID, runID, code, err.Error())
	}
}

func kbrainOptions(body handler.ChatRequestBody) *kbrain.RunOptions {
	options := &kbrain.RunOptions{
		Mode:           "chat",
		Search:         "disabled",
		ApprovalPolicy: "ask",
		PermissionMode: "normal",
	}
	if body.ExecutionMode == "tools" || body.ExecutionMode == "agent-dev" {
		options.Mode = "agent"
	}
	switch body.CommandSafetyMode {
	case "auto":
		options.ApprovalPolicy = "auto"
		options.PermissionMode = "full_access"
	case "autoEdit":
		options.PermissionMode = "auto_edit"
	case "always":
		options.PermissionMode = "always"
	case "autoReview":
		options.PermissionMode = "auto_review"
	case "sandboxOffline":
		options.ApprovalPolicy = "deny"
	}
	if body.RuntimeControls != nil {
		options.Reasoning = body.RuntimeControls.Reasoning
		if body.RuntimeControls.ThinkingEnabled != nil && !*body.RuntimeControls.ThinkingEnabled {
			options.Reasoning = "off"
		}
		if body.RuntimeControls.NativeWebSearchEnabled != nil && *body.RuntimeControls.NativeWebSearchEnabled {
			options.Search = "enabled"
		}
		if body.RuntimeControls.PlanModeEnabled != nil {
			options.PlanModeEnabled = *body.RuntimeControls.PlanModeEnabled
			if options.PlanModeEnabled {
				options.PermissionMode = "plan"
			}
		}
	}
	if body.PlanCommand {
		options.PlanModeEnabled = true
		options.PermissionMode = "plan"
	}
	if strings.TrimSpace(body.Workdir) != "" {
		options.WorkspaceRoots = []kbrain.WorkspaceRoot{{Path: body.Workdir, Access: "write"}}
	}
	return options
}

func (s *Server) kbrainCallbacks(agentID string) kbrain.Callbacks {
	return kbrain.Callbacks{
		OnEvent: func(runID string, event *gatewayv2.ChatEvent) { s.sm.IngestRemoteChatEvent(agentID, runID, event) },
		OnControl: func(runID string, control *gatewayv2.ChatControlEvent) {
			s.sm.IngestRemoteChatControl(agentID, runID, control)
		},
		OnQueue: func(conversationID, snapshot string, revision uint64) {
			s.sm.BroadcastRemoteChatQueue(agentID, &gatewayv2.ChatQueueEvent{ConversationId: conversationID, SnapshotJson: snapshot, Revision: revision})
		},
		OnHistoryEvent: func(event *gatewayv2.HistorySyncEvent) {
			s.sm.IngestRemoteHistoryEvent(agentID, event)
		},
		OnHistoryStatus: func(status *gatewayv2.HistorySyncStatus) {
			s.sm.IngestRemoteHistoryStatus(agentID, status)
		},
		OnHistorySnapshot: func(snapshot *gatewayv2.HistorySyncSnapshot) {
			s.sm.IngestRemoteHistorySnapshot(agentID, snapshot)
		},
	}
}

// respondChatCommandDeduped 用既有运行应答重复的 client_request_id 并转发其（回放的）
// 前置阶段更新；观察流由看门狗窗口兜底关闭。
func (c *browserConn) respondChatCommandDeduped(requestID string, start session.ChatCommandStart) {
	updates, cleanupWatch := c.sm.WatchChatCommand(start.AgentID, start.RunID)
	_ = c.sendChatCommandAccepted(requestID, start)
	go c.forwardChatCommandUpdates(updates, cleanupWatch)
	cleanupChatCommandWatchAfter(c.cfg, cleanupWatch)
}

func (c *browserConn) sendChatCommandAccepted(requestID string, start session.ChatCommandStart) error {
	// 接受回执延迟敏感，走控制队列。
	return c.send(wscore.FrameControl, "chat_accepted", &gatewayv2.WebServerFrame{
		RequestId: requestID,
		AgentId:   start.AgentID,
		Payload: &gatewayv2.WebServerFrame_ChatAccepted{
			ChatAccepted: &gatewayv2.ChatCommandAccepted{
				RunId:          start.RunID,
				ConversationId: start.ConversationID,
				AcceptedSeq:    start.AcceptedSeq,
				Deduped:        start.Deduped,
			},
		},
	})
}

// forwardChatCommandUpdates 把前置阶段结果（bound / queued_in_gui / failed）推给
// 发起命令的连接（走控制队列）。
func (c *browserConn) forwardChatCommandUpdates(
	updates <-chan session.ChatCommandUpdate,
	cleanup func(),
) {
	if cleanup != nil {
		defer cleanup()
	}
	for {
		select {
		case <-c.done:
			return
		case update, ok := <-updates:
			if !ok {
				return
			}
			if err := c.send(wscore.FrameControl, "chat_command_update", &gatewayv2.WebServerFrame{
				AgentId: update.AgentID,
				Payload: &gatewayv2.WebServerFrame_ChatCommandUpdate{
					ChatCommandUpdate: chatCommandUpdate(update),
				},
			}); err != nil {
				return
			}
		}
	}
}

// cleanupChatCommandWatchAfter 为去重提交的更新观察流设兜底关闭窗口
// （AfterFunc 不占 goroutine，cleanup 幂等）。
func cleanupChatCommandWatchAfter(cfg *config.Config, cleanup func()) {
	if cleanup == nil {
		return
	}
	timeout := chatcmd.StartTimeout(cfg) + chatcmd.RenderStartTimeout(cfg)
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	time.AfterFunc(timeout, cleanup)
}

const chatCancelWatchdogTimeout = 15 * time.Second

// handleChatCancel 处理 chat.cancel。取消只作用于请求显式声明的 Agent，
// 即使其他 Agent 恰好有同名 conversation_id 也不会被跨 Agent 取消。
func (c *browserConn) handleChatCancel(requestID, agentID string, cancelReq *gatewayv2.CancelChatRequest) {
	conversationID := strings.TrimSpace(cancelReq.GetConversationId())
	if conversationID == "" {
		_ = c.sendLocalError(requestID, "conversation_id is required")
		return
	}
	if c.srv.kbrainRelay != nil && agentID == c.srv.kbrainTargetID {
		requestedRunID := strings.TrimSpace(cancelReq.GetRunId())
		runID, active := c.sm.MarkConversationCancelling(agentID, conversationID, requestedRunID)
		if requestedRunID == "" {
			requestedRunID = runID
		}
		cancelled, _ := c.srv.kbrainRelay.Cancel(context.Background(), conversationID, requestedRunID)
		if cancelled {
			active = true
			if runID == "" {
				runID = requestedRunID
			}
		}
		_ = c.sendChatCancelResult(requestID, active, runID, conversationID)
		return
	}
	if !c.sm.IsOnline(agentID) {
		_ = c.sendLocalError(requestID, "agent offline")
		return
	}

	// 不终结运行：活动状态翻为 cancelling，以桌面端终态信号为准，超时由看门狗强制收尾。
	runID, active := c.sm.MarkConversationCancelling(agentID, conversationID, strings.TrimSpace(cancelReq.GetRunId()))
	if !active {
		_ = c.sendChatCancelResult(requestID, false, "", conversationID)
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), c.srv.writeTimeout())
	defer cancel()

	if err := c.sm.SendToAgentContext(ctx, agentID, &gatewayv2.GatewayEnvelope{
		RequestId: runID,
		Timestamp: time.Now().Unix(),
		Payload:   chatcmd.BuildCancelCommandPayload(conversationID),
	}); err != nil {
		_ = c.sendLocalError(requestID, errorMessage(err))
		return
	}

	go watchChatCancel(c.sm, agentID, runID)
	_ = c.sendChatCancelResult(requestID, true, runID, conversationID)
}

func (c *browserConn) sendChatCancelResult(requestID string, ok bool, runID, conversationID string) error {
	return c.send(wscore.FrameResponse, "chat_cancelled", &gatewayv2.WebServerFrame{
		RequestId: requestID,
		Payload: &gatewayv2.WebServerFrame_ChatCancelled{
			ChatCancelled: &gatewayv2.ChatCancelResult{
				Ok:             ok,
				RunId:          runID,
				ConversationId: conversationID,
			},
		},
	})
}

func watchChatCancel(sm *session.Manager, agentID string, runID string) {
	time.Sleep(chatCancelWatchdogTimeout)
	sm.ForceFinishRun(agentID, runID, "cancelled", "cancel_timeout",
		"The desktop runtime did not confirm the cancellation in time.")
}
