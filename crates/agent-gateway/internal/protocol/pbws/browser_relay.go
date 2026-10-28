package pbws

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/protocol/shared"
	"github.com/liveagent/agent-gateway/internal/transport/wscore"
)

func (c *browserConn) sendKBrainResponse(requestID, agentID string, response *gatewayv2.AgentEnvelope) {
	response.RequestId = requestID
	response.Timestamp = time.Now().Unix()
	_ = c.send(wscore.FrameResponse, "agent_response", &gatewayv2.WebServerFrame{
		RequestId: requestID, AgentId: agentID,
		Payload: &gatewayv2.WebServerFrame_AgentResponse{AgentResponse: response},
	})
}

func (c *browserConn) handleKBrainCronManage(requestID, agentID string, request *gatewayv2.CronManageRequest) {
	ctx, cancel := context.WithTimeout(context.Background(), c.srv.requestTimeout())
	defer cancel()
	response, err := c.srv.kbrainRelay.CronManage(ctx, request)
	if err != nil {
		_ = c.sendLocalError(requestID, errorMessage(err))
		return
	}
	c.sendKBrainResponse(requestID, agentID, &gatewayv2.AgentEnvelope{Payload: &gatewayv2.AgentEnvelope_CronManageResp{CronManageResp: response}})
}

func (c *browserConn) handleKBrainHistoryList(requestID, agentID string, request *gatewayv2.HistoryListRequest) {
	ctx, cancel := context.WithTimeout(context.Background(), c.srv.requestTimeout())
	defer cancel()
	response, err := c.srv.kbrainRelay.HistoryList(ctx, request)
	if err != nil {
		_ = c.sendLocalError(requestID, errorMessage(err))
		return
	}
	c.sendKBrainResponse(requestID, agentID, &gatewayv2.AgentEnvelope{Payload: &gatewayv2.AgentEnvelope_HistoryListResp{HistoryListResp: response}})
}

func (c *browserConn) handleKBrainHistoryWorkdirs(requestID, agentID string, request *gatewayv2.HistoryWorkdirsRequest) {
	ctx, cancel := context.WithTimeout(context.Background(), c.srv.requestTimeout())
	defer cancel()
	response, err := c.srv.kbrainRelay.HistoryWorkdirs(ctx, request)
	if err != nil {
		_ = c.sendLocalError(requestID, errorMessage(err))
		return
	}
	c.sendKBrainResponse(requestID, agentID, &gatewayv2.AgentEnvelope{Payload: &gatewayv2.AgentEnvelope_HistoryWorkdirsResp{HistoryWorkdirsResp: response}})
}

func (c *browserConn) handleKBrainHistoryGet(requestID, agentID string, request *gatewayv2.HistoryGetRequest) {
	ctx, cancel := context.WithTimeout(context.Background(), c.srv.requestTimeout())
	defer cancel()
	response, err := c.srv.kbrainRelay.HistoryGet(ctx, request)
	if err != nil {
		_ = c.sendLocalError(requestID, errorMessage(err))
		return
	}
	c.sendKBrainResponse(requestID, agentID, &gatewayv2.AgentEnvelope{Payload: &gatewayv2.AgentEnvelope_HistoryGetResp{HistoryGetResp: response}})
}

func (c *browserConn) handleKBrainHistoryRename(requestID, agentID string, request *gatewayv2.HistoryRenameRequest) {
	ctx, cancel := context.WithTimeout(context.Background(), c.srv.requestTimeout())
	defer cancel()
	response, err := c.srv.kbrainRelay.HistoryRename(ctx, request)
	if err != nil {
		_ = c.sendLocalError(requestID, errorMessage(err))
		return
	}
	c.sendKBrainResponse(requestID, agentID, &gatewayv2.AgentEnvelope{Payload: &gatewayv2.AgentEnvelope_HistoryRenameResp{HistoryRenameResp: response}})
}

func (c *browserConn) handleKBrainHistoryPin(requestID, agentID string, request *gatewayv2.HistoryPinRequest) {
	ctx, cancel := context.WithTimeout(context.Background(), c.srv.requestTimeout())
	defer cancel()
	response, err := c.srv.kbrainRelay.HistoryPin(ctx, request)
	if err != nil {
		_ = c.sendLocalError(requestID, errorMessage(err))
		return
	}
	c.sendKBrainResponse(requestID, agentID, &gatewayv2.AgentEnvelope{Payload: &gatewayv2.AgentEnvelope_HistoryPinResp{HistoryPinResp: response}})
}

func (c *browserConn) handleKBrainHistoryDelete(requestID, agentID string, request *gatewayv2.HistoryDeleteRequest) {
	ctx, cancel := context.WithTimeout(context.Background(), c.srv.requestTimeout())
	defer cancel()
	response, err := c.srv.kbrainRelay.HistoryDelete(ctx, request)
	if err != nil {
		_ = c.sendLocalError(requestID, errorMessage(err))
		return
	}
	c.sendKBrainResponse(requestID, agentID, &gatewayv2.AgentEnvelope{Payload: &gatewayv2.AgentEnvelope_HistoryDeleteResp{HistoryDeleteResp: response}})
}

func (c *browserConn) handleKBrainHistorySetCwd(requestID, agentID string, request *gatewayv2.HistorySetCwdRequest) {
	ctx, cancel := context.WithTimeout(context.Background(), c.srv.requestTimeout())
	defer cancel()
	response, err := c.srv.kbrainRelay.HistorySetCwd(ctx, request)
	if err != nil {
		_ = c.sendLocalError(requestID, errorMessage(err))
		return
	}
	c.sendKBrainResponse(requestID, agentID, &gatewayv2.AgentEnvelope{Payload: &gatewayv2.AgentEnvelope_HistorySetCwdResp{HistorySetCwdResp: response}})
}

func (c *browserConn) handleKBrainSettingsGet(requestID, agentID string, request *gatewayv2.SettingsGetRequest) {
	ctx, cancel := context.WithTimeout(context.Background(), c.srv.requestTimeout())
	defer cancel()
	response, err := c.srv.kbrainRelay.SettingsGet(ctx, request)
	if err != nil {
		_ = c.sendLocalError(requestID, errorMessage(err))
		return
	}
	c.sendKBrainResponse(requestID, agentID, &gatewayv2.AgentEnvelope{Payload: &gatewayv2.AgentEnvelope_SettingsGetResp{SettingsGetResp: response}})
}

func (c *browserConn) handleKBrainSettingsUpdate(requestID, agentID string, request *gatewayv2.SettingsUpdateRequest) {
	ctx, cancel := context.WithTimeout(context.Background(), c.srv.requestTimeout())
	defer cancel()
	response, err := c.srv.kbrainRelay.SettingsUpdate(ctx, request)
	if err != nil {
		_ = c.sendLocalError(requestID, errorMessage(err))
		return
	}
	c.sendKBrainResponse(requestID, agentID, &gatewayv2.AgentEnvelope{Payload: &gatewayv2.AgentEnvelope_SettingsUpdateResp{SettingsUpdateResp: response}})
}

func (c *browserConn) handleKBrainProviderList(requestID, agentID string, request *gatewayv2.ProviderListRequest) {
	ctx, cancel := context.WithTimeout(context.Background(), c.srv.requestTimeout())
	defer cancel()
	raw, err := c.srv.kbrainRelay.ProviderList(ctx, request)
	if err != nil {
		_ = c.sendLocalError(requestID, errorMessage(err))
		return
	}
	var document struct {
		Providers []any `json:"providers"`
	}
	if err := json.Unmarshal(raw, &document); err != nil {
		_ = c.sendLocalError(requestID, errorMessage(err))
		return
	}
	providers, err := json.Marshal(document.Providers)
	if err != nil {
		_ = c.sendLocalError(requestID, errorMessage(err))
		return
	}
	c.sendKBrainResponse(requestID, agentID, &gatewayv2.AgentEnvelope{Payload: &gatewayv2.AgentEnvelope_ProviderListResp{ProviderListResp: &gatewayv2.ProviderListResponse{ProvidersJson: string(providers)}}})
}

func (c *browserConn) handleKBrainProviderModels(requestID, agentID string, request *gatewayv2.ProviderModelsRequest) {
	ctx, cancel := context.WithTimeout(context.Background(), c.srv.requestTimeout())
	defer cancel()
	response, err := c.srv.kbrainRelay.ProviderModels(ctx, request)
	if err != nil {
		_ = c.sendLocalError(requestID, errorMessage(err))
		return
	}
	c.sendKBrainResponse(requestID, agentID, &gatewayv2.AgentEnvelope{Payload: &gatewayv2.AgentEnvelope_ProviderModelsResp{ProviderModelsResp: response}})
}

func (c *browserConn) handleKBrainMemoryManage(requestID, agentID string, request *gatewayv2.MemoryManageRequest) {
	ctx, cancel := context.WithTimeout(context.Background(), c.srv.requestTimeout())
	defer cancel()
	response, err := c.srv.kbrainRelay.MemoryManage(ctx, request)
	if err != nil {
		_ = c.sendLocalError(requestID, errorMessage(err))
		return
	}
	c.sendKBrainResponse(requestID, agentID, &gatewayv2.AgentEnvelope{Payload: &gatewayv2.AgentEnvelope_MemoryManageResp{MemoryManageResp: response}})
}

func (c *browserConn) handleKBrainChatQueue(requestID, agentID string, request *gatewayv2.ChatQueueRequest) {
	ctx, cancel := context.WithTimeout(context.Background(), c.srv.requestTimeout())
	defer cancel()
	response := c.srv.kbrainRelay.Queue(ctx, request, c.srv.kbrainCallbacks(agentID))
	c.sendKBrainResponse(requestID, agentID, &gatewayv2.AgentEnvelope{Payload: &gatewayv2.AgentEnvelope_ChatQueueResp{ChatQueueResp: &gatewayv2.ChatQueueResponse{
		Accepted: response.Accepted, Message: response.Message, SnapshotJson: response.SnapshotJSON,
		ItemJson: response.ItemJSON, ErrorCode: response.ErrorCode, Revision: response.Revision,
	}}})
}

func (c *browserConn) handleAgentRequest(requestID, agentID string, env *gatewayv2.GatewayEnvelope) {
	if requestID == "" {
		_ = c.sendLocalError(requestID, "request id is required")
		return
	}
	if c.srv.kbrainRelay != nil && agentID == c.srv.kbrainTargetID {
		ctx, cancel := context.WithTimeout(context.Background(), c.srv.requestTimeout())
		defer cancel()
		if response, handled, err := c.srv.kbrainRelay.Filesystem(ctx, env); handled {
			if err != nil {
				_ = c.sendLocalError(requestID, errorMessage(err))
				return
			}
			c.sendKBrainResponse(requestID, agentID, response)
			return
		}
		if request := env.GetSlashCommandList(); request != nil {
			if err := vetSlashCommandList(request); err != nil {
				_ = c.sendLocalError(requestID, err.Error())
				return
			}
			ctx, cancel := context.WithTimeout(context.Background(), c.srv.requestTimeout())
			defer cancel()
			response, err := c.srv.kbrainRelay.SlashCommands(ctx, request)
			if err != nil {
				_ = c.sendLocalError(requestID, errorMessage(err))
				return
			}
			c.sendKBrainResponse(requestID, agentID, &gatewayv2.AgentEnvelope{Payload: &gatewayv2.AgentEnvelope_SlashCommandListResp{SlashCommandListResp: response}})
			return
		}
		if request := env.GetLoopManage(); request != nil {
			if err := vetLoopManage(request); err != nil {
				_ = c.sendLocalError(requestID, err.Error())
				return
			}
			ctx, cancel := context.WithTimeout(context.Background(), c.srv.requestTimeout())
			defer cancel()
			response, err := c.srv.kbrainRelay.Loops(ctx, request)
			if err != nil {
				_ = c.sendLocalError(requestID, errorMessage(err))
				return
			}
			c.sendKBrainResponse(requestID, agentID, &gatewayv2.AgentEnvelope{Payload: &gatewayv2.AgentEnvelope_LoopManageResp{LoopManageResp: response}})
			return
		}
		if request := env.GetSkillManage(); request != nil {
			ctx, cancel := context.WithTimeout(context.Background(), c.srv.requestTimeout())
			defer cancel()
			response, err := c.srv.kbrainRelay.SkillManage(ctx, request)
			if err != nil {
				_ = c.sendLocalError(requestID, errorMessage(err))
				return
			}
			c.sendKBrainResponse(requestID, agentID, &gatewayv2.AgentEnvelope{Payload: &gatewayv2.AgentEnvelope_SkillManageResp{SkillManageResp: response}})
			return
		}
		if env.GetPlanning() != nil {
			ctx, cancel := context.WithTimeout(context.Background(), c.srv.requestTimeout())
			defer cancel()
			response, err := c.srv.kbrainRelay.Planning(ctx, env.GetPlanning())
			if err != nil {
				_ = c.sendLocalError(requestID, errorMessage(err))
				return
			}
			c.sendKBrainResponse(requestID, agentID, &gatewayv2.AgentEnvelope{Payload: &gatewayv2.AgentEnvelope_PlanningResp{PlanningResp: response}})
			return
		}
		if settingsGet := env.GetSettingsGet(); settingsGet != nil {
			c.handleKBrainSettingsGet(requestID, agentID, settingsGet)
			return
		}
		if settingsUpdate := env.GetSettingsUpdate(); settingsUpdate != nil {
			c.handleKBrainSettingsUpdate(requestID, agentID, settingsUpdate)
			return
		}
		if providerList := env.GetProviderList(); providerList != nil {
			c.handleKBrainProviderList(requestID, agentID, providerList)
			return
		}
		if providerModels := env.GetProviderModels(); providerModels != nil {
			c.handleKBrainProviderModels(requestID, agentID, providerModels)
			return
		}
		if memoryManage := env.GetMemoryManage(); memoryManage != nil {
			c.handleKBrainMemoryManage(requestID, agentID, memoryManage)
			return
		}
		if historyList := env.GetHistoryList(); historyList != nil {
			c.handleKBrainHistoryList(requestID, agentID, historyList)
			return
		}
		if historyWorkdirs := env.GetHistoryWorkdirs(); historyWorkdirs != nil {
			c.handleKBrainHistoryWorkdirs(requestID, agentID, historyWorkdirs)
			return
		}
		if historyGet := env.GetHistoryGet(); historyGet != nil {
			c.handleKBrainHistoryGet(requestID, agentID, historyGet)
			return
		}
		if historyRename := env.GetHistoryRename(); historyRename != nil {
			c.handleKBrainHistoryRename(requestID, agentID, historyRename)
			return
		}
		if historyPin := env.GetHistoryPin(); historyPin != nil {
			c.handleKBrainHistoryPin(requestID, agentID, historyPin)
			return
		}
		if historyCwd := env.GetHistorySetCwd(); historyCwd != nil {
			c.handleKBrainHistorySetCwd(requestID, agentID, historyCwd)
			return
		}
		if historyDelete := env.GetHistoryDelete(); historyDelete != nil {
			c.handleKBrainHistoryDelete(requestID, agentID, historyDelete)
			return
		}
	}
	if cron := env.GetCronManage(); cron != nil && c.srv.kbrainRelay != nil && agentID == c.srv.kbrainTargetID {
		c.handleKBrainCronManage(requestID, agentID, cron)
		return
	}
	if queue := env.GetChatQueue(); queue != nil && c.srv.kbrainRelay != nil && agentID == c.srv.kbrainTargetID {
		c.handleKBrainChatQueue(requestID, agentID, queue)
		return
	}
	if terminal := env.GetTerminalRequest(); terminal != nil && c.srv.kbrainRelay != nil && agentID == c.srv.kbrainTargetID {
		if err := vetCanonicalTerminal(terminal); err != nil {
			_ = c.sendLocalError(requestID, err.Error())
			return
		}
		view := c.sm.AgentView(agentID)
		if !shared.TerminalRequestAllowed(view, strings.TrimSpace(terminal.GetAction()), strings.TrimSpace(terminal.GetSessionId())) {
			_ = c.sendLocalError(requestID, shared.TerminalPermissionError(strings.TrimSpace(terminal.GetAction())))
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), c.srv.requestTimeout())
		defer cancel()
		response, err := c.srv.kbrainRelay.Terminal(ctx, terminal)
		if err != nil {
			_ = c.sendLocalError(requestID, errorMessage(err))
			return
		}
		response = shared.FinalizeTerminalResponse(
			view,
			c.terminalInterest,
			strings.TrimSpace(terminal.GetAction()),
			strings.TrimSpace(terminal.GetProjectPathKey()),
			response,
		)
		c.sendKBrainResponse(requestID, agentID, &gatewayv2.AgentEnvelope{Payload: &gatewayv2.AgentEnvelope_TerminalResponse{TerminalResponse: response}})
		return
	}
	view := c.sm.AgentView(agentID)
	if err := vetAgentRequest(view, env); err != nil {
		_ = c.sendLocalError(requestID, err.Error())
		return
	}
	agentRequestID := c.idPrefix + requestID
	env.RequestId = agentRequestID
	if env.GetTimestamp() == 0 {
		env.Timestamp = time.Now().Unix()
	}
	ctx, cancel := context.WithTimeout(context.Background(), c.srv.requestTimeout())
	defer cancel()
	go func() {
		select {
		case <-c.done:
			cancel()
		case <-ctx.Done():
		}
	}()
	if env.GetClarifyTurn() != nil {
		unwatch := c.sm.WatchClarifyDeltas(agentRequestID, func(delta *gatewayv2.ClarifyTurnDelta) {
			if delta == nil {
				return
			}
			_ = c.send(wscore.FrameResponse, "agent_response", &gatewayv2.WebServerFrame{RequestId: requestID, AgentId: agentID, Payload: &gatewayv2.WebServerFrame_AgentResponse{AgentResponse: &gatewayv2.AgentEnvelope{RequestId: requestID, Timestamp: time.Now().Unix(), Payload: &gatewayv2.AgentEnvelope_ClarifyTurnDelta{ClarifyTurnDelta: delta}}}})
		})
		defer unwatch()
	}
	response, err := c.sm.AwaitUnaryResponse(ctx, agentID, agentRequestID, env)
	if err != nil {
		_ = c.sendLocalError(requestID, errorMessage(err))
		return
	}
	if terminalResp := response.GetTerminalResponse(); terminalResp != nil {
		req := env.GetTerminalRequest()
		finalized := shared.FinalizeTerminalResponse(view, c.terminalInterest, strings.TrimSpace(req.GetAction()), strings.TrimSpace(req.GetProjectPathKey()), terminalResp)
		if finalized != terminalResp {
			response.Payload = &gatewayv2.AgentEnvelope_TerminalResponse{TerminalResponse: finalized}
		}
	}
	response.RequestId = requestID
	_ = c.send(wscore.FrameResponse, "agent_response", &gatewayv2.WebServerFrame{RequestId: requestID, AgentId: agentID, Payload: &gatewayv2.WebServerFrame_AgentResponse{AgentResponse: response}})
}
