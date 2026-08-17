package pbws

import (
	"errors"
	"strings"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/protocol/shared"
	"github.com/liveagent/agent-gateway/internal/session"
)

// 直通白名单与限额校验：本文件明确限定浏览器可发起的操作——未列入白名单的载荷臂（内部推送臂、须走网关编排的 chat_command、ping 等）
// 一律拒绝；功能开关门控与字段限额在转发前施加；list 类响应后处理经 finalize 钩子执行。

const (
	maxHistoryListLimit        = 200
	defaultHistoryListPage     = 1
	defaultHistoryListPageSize = 80
	maxWorkspaceRootGrants     = 64
)

// vetAgentRequest 校验并（必要时）原地修正一条直通请求；返回错误则拒绝转发，错误信息面向客户端。
// 门控按目标 Agent 的视图判定（sm 为绑定 agent_id 的只读视图）。
func vetAgentRequest(sm session.AgentView, env *gatewayv2.GatewayEnvelope) error {
	switch payload := env.GetPayload().(type) {
	case nil:
		return errors.New("agent_request payload is required")

	// ---- 普通直通臂（无门控） ----
	case *gatewayv2.GatewayEnvelope_HistoryList:
		clampHistoryList(payload.HistoryList)
		return nil
	case *gatewayv2.GatewayEnvelope_HistoryGet,
		*gatewayv2.GatewayEnvelope_HistoryRename,
		*gatewayv2.GatewayEnvelope_HistoryDelete,
		*gatewayv2.GatewayEnvelope_HistoryPrefix,
		*gatewayv2.GatewayEnvelope_HistoryPin,
		*gatewayv2.GatewayEnvelope_HistorySetCwd,
		*gatewayv2.GatewayEnvelope_HistoryShareGet,
		*gatewayv2.GatewayEnvelope_HistoryShareSet,
		*gatewayv2.GatewayEnvelope_HistoryWorkdirs,
		*gatewayv2.GatewayEnvelope_HistoryBranch,
		*gatewayv2.GatewayEnvelope_ProviderList,
		*gatewayv2.GatewayEnvelope_ProviderUsage,
		*gatewayv2.GatewayEnvelope_ProviderModels,
		*gatewayv2.GatewayEnvelope_SettingsGet,
		*gatewayv2.GatewayEnvelope_SettingsUpdate,
		*gatewayv2.GatewayEnvelope_SettingsResetSshKnownHost,
		*gatewayv2.GatewayEnvelope_SkillFilesList,
		*gatewayv2.GatewayEnvelope_SkillMetadataRead,
		*gatewayv2.GatewayEnvelope_SkillTextRead,
		*gatewayv2.GatewayEnvelope_SkillManage,
		*gatewayv2.GatewayEnvelope_FileMentionList,
		*gatewayv2.GatewayEnvelope_UploadedImagePreview,
		*gatewayv2.GatewayEnvelope_MemoryManage,
		*gatewayv2.GatewayEnvelope_CronManage,
		*gatewayv2.GatewayEnvelope_FsRoots,
		*gatewayv2.GatewayEnvelope_FsListDirs,
		*gatewayv2.GatewayEnvelope_FsCreateProjectFolder,
		*gatewayv2.GatewayEnvelope_FsList,
		*gatewayv2.GatewayEnvelope_FsWriteText,
		*gatewayv2.GatewayEnvelope_FsCreateDir,
		*gatewayv2.GatewayEnvelope_FsRename,
		*gatewayv2.GatewayEnvelope_FsDelete,
		*gatewayv2.GatewayEnvelope_FsReadEditableText,
		*gatewayv2.GatewayEnvelope_FsReadWorkspaceImage,
		*gatewayv2.GatewayEnvelope_ChatQueue:
		return nil
	case *gatewayv2.GatewayEnvelope_ChatFileOpen:
		return vetChatFileOpen(payload.ChatFileOpen)
	case *gatewayv2.GatewayEnvelope_WorkspaceRootGrants:
		return vetWorkspaceRootGrants(payload.WorkspaceRootGrants)
	case *gatewayv2.GatewayEnvelope_Checkpoint:
		return vetCheckpoint(payload.Checkpoint)

	// ---- 带功能门控 / 限额的直通臂 ----
	case *gatewayv2.GatewayEnvelope_GitRequest:
		action := strings.TrimSpace(payload.GitRequest.GetAction())
		if gitActionIsWrite(action) && !sm.WebGitEnabled() {
			return errors.New("web git is disabled in desktop Remote settings")
		}
		return nil
	case *gatewayv2.GatewayEnvelope_TerminalRequest:
		req := payload.TerminalRequest
		action := strings.TrimSpace(req.GetAction())
		if !shared.TerminalRequestAllowed(sm, action, strings.TrimSpace(req.GetSessionId())) {
			return errors.New(shared.TerminalPermissionError(action))
		}
		return nil
	case *gatewayv2.GatewayEnvelope_SftpRequest:
		if !sm.WebSshTerminalEnabled() {
			return errors.New("web SSH SFTP is disabled in desktop Remote settings")
		}
		return nil
	case *gatewayv2.GatewayEnvelope_TunnelMutation:
		if !sm.WebTunnelsEnabled() {
			return errors.New("web tunnels are disabled in desktop Remote settings")
		}
		return nil
	case *gatewayv2.GatewayEnvelope_ManagedProcessRequest:
		req := payload.ManagedProcessRequest
		action := strings.TrimSpace(req.GetAction())
		if strings.TrimSpace(req.GetProcessId()) == "" && action != "clear" && action != "snapshot" {
			return errors.New("process_id is required")
		}
		return nil

	// ---- 明确拒绝的臂 ----
	default:
		// 含 chat_command（须走网关编排）、ping（探活由网关发起）、upload_readable_files
		// （走 HTTP 上传）、history_share_resolve（公共分享端点专用）及网关内部推送臂。
		return errors.New("unsupported agent_request payload")
	}
}

func vetCheckpoint(req *gatewayv2.CheckpointRequest) error {
	if req == nil || strings.TrimSpace(req.GetConversationId()) == "" || len(req.GetConversationId()) > 256 {
		return errors.New("checkpoint conversation_id is invalid")
	}
	switch strings.TrimSpace(req.GetAction()) {
	case "list":
		if req.GetTurnSeq() != 0 || len(req.GetAuthorizedRoots()) != 0 || len(req.GetExpected()) != 0 {
			return errors.New("checkpoint list payload is invalid")
		}
	case "diff":
		if req.GetTurnSeq() == 0 || len(req.GetExpected()) != 0 {
			return errors.New("checkpoint diff payload is invalid")
		}
	case "rewind":
		if req.GetTurnSeq() == 0 {
			return errors.New("checkpoint rewind turn_seq is required")
		}
	default:
		return errors.New("checkpoint action is invalid")
	}
	if len(req.GetAuthorizedRoots()) > 64 {
		return errors.New("too many checkpoint authorized roots")
	}
	for _, root := range req.GetAuthorizedRoots() {
		if strings.TrimSpace(root) == "" || len(root) > 32768 {
			return errors.New("checkpoint authorized root is invalid")
		}
	}
	if len(req.GetExpected()) > 10_000 {
		return errors.New("too many checkpoint expected entries")
	}
	for _, entry := range req.GetExpected() {
		if entry == nil || strings.TrimSpace(entry.GetKey()) == "" || len(entry.GetKey()) > 65536 || len(entry.GetCurrentHash()) > 256 {
			return errors.New("checkpoint expected entry is invalid")
		}
	}
	return nil
}

func vetWorkspaceRootGrants(req *gatewayv2.WorkspaceRootGrantsRequest) error {
	if req == nil {
		return errors.New("workspace root grants request is required")
	}
	if strings.TrimSpace(req.GetProjectId()) == "" || len(req.GetProjectId()) > 256 {
		return errors.New("workspace root grants project_id is invalid")
	}
	switch strings.TrimSpace(req.GetAction()) {
	case "list":
		if strings.TrimSpace(req.GetProjectPath()) == "" || len(req.GetProjectPath()) > 32768 {
			return errors.New("workspace root grants project_path is invalid")
		}
		if len(req.GetGrants()) != 0 {
			return errors.New("workspace root grants list cannot include drafts")
		}
		return nil
	case "apply":
		if strings.TrimSpace(req.GetProjectPath()) == "" || len(req.GetProjectPath()) > 32768 {
			return errors.New("workspace root grants project_path is invalid")
		}
		if len(req.GetGrants()) > maxWorkspaceRootGrants {
			return errors.New("too many workspace root grants")
		}
	case "revoke":
		if strings.TrimSpace(req.GetProjectPath()) != "" {
			return errors.New("workspace root grants revoke cannot include project_path")
		}
		if len(req.GetGrants()) != 0 {
			return errors.New("workspace root grants revoke cannot include drafts")
		}
		return nil
	default:
		return errors.New("workspace root grants action is invalid")
	}

	for _, grant := range req.GetGrants() {
		if grant == nil || strings.TrimSpace(grant.GetAlias()) == "" || len(grant.GetAlias()) > 32 {
			return errors.New("workspace root grant alias is invalid")
		}
		if strings.TrimSpace(grant.GetDisplayPath()) == "" || len(grant.GetDisplayPath()) > 32768 {
			return errors.New("workspace root grant display_path is invalid")
		}
		if grant.Id != nil && (strings.TrimSpace(grant.GetId()) == "" || len(grant.GetId()) > 256) {
			return errors.New("workspace root grant id is invalid")
		}
		switch strings.TrimSpace(grant.GetAccess()) {
		case "read", "write":
		default:
			return errors.New("workspace root grant access is invalid")
		}
	}
	return nil
}

func vetChatFileOpen(req *gatewayv2.ChatFileOpenRequest) error {
	if req == nil || strings.TrimSpace(req.GetConversationId()) == "" || len(req.GetConversationId()) > 256 {
		return errors.New("conversation is unavailable")
	}
	if strings.TrimSpace(req.GetWorkdir()) == "" || strings.TrimSpace(req.GetPath()) == "" {
		return errors.New("linked file request is incomplete")
	}
	if len(req.GetWorkdir()) > 32768 || len(req.GetPath()) > 32768 {
		return errors.New("linked file request is too large")
	}
	switch strings.TrimSpace(req.GetSource()) {
	case "absolute", "relative", "file-url":
	default:
		return errors.New("linked file source is invalid")
	}
	if (req.Line != nil && req.GetLine() == 0) ||
		(req.EndLine != nil && req.GetEndLine() == 0) ||
		(req.Column != nil && req.GetColumn() == 0) {
		return errors.New("linked file location is invalid")
	}
	if req.Line == nil && (req.EndLine != nil || req.Column != nil) {
		return errors.New("linked file location is invalid")
	}
	if req.Line != nil && req.EndLine != nil && req.GetEndLine() < req.GetLine() {
		return errors.New("linked file location is invalid")
	}
	return nil
}

// gitActionIsWrite 判定 git 直通请求是否为写操作：写操作受桌面端 Remote 设置
// enable_web_git 门控，读操作（status/log/diff 等）始终放行。
func gitActionIsWrite(action string) bool {
	switch action {
	case "clone", "clone_start", "clone_cancel", "clone_dismiss", "init", "switch_branch", "create_branch", "create_worktree", "stage", "stage_all", "unstage", "unstage_all", "discard", "discard_all", "add_to_gitignore", "commit", "fetch", "pull", "set_remote", "push", "delete_branch", "rename_branch", "remove_worktree", "stash_push", "stash_pop":
		return true
	default:
		return false
	}
}

// clampHistoryList 施加历史列表的分页默认值与上限。
func clampHistoryList(req *gatewayv2.HistoryListRequest) {
	if req == nil {
		return
	}
	if req.GetPage() <= 0 {
		req.Page = defaultHistoryListPage
	}
	if req.GetPageSize() <= 0 {
		req.PageSize = defaultHistoryListPageSize
	} else if req.GetPageSize() > maxHistoryListLimit {
		req.PageSize = maxHistoryListLimit
	}
}
