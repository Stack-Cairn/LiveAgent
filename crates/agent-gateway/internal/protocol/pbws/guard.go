package pbws

import (
	"errors"
	"strings"

	gatewayv1 "github.com/liveagent/agent-gateway/internal/proto/v1"
	"github.com/liveagent/agent-gateway/internal/protocol/shared"
	"github.com/liveagent/agent-gateway/internal/session"
)

// 直通白名单与限额校验：v1 路由表天然充当的"浏览器可发起哪些操作"白名单，在 v2 信封直通后
// 由本文件承接——未列入白名单的载荷臂（内部推送臂、须走网关编排的 chat_command、ping 等）
// 一律拒绝；功能开关门控与字段限额在转发前施加；list 类响应后处理经 finalize 钩子执行。

const (
	maxHistoryListLimit        = 200
	defaultHistoryListPage     = 1
	defaultHistoryListPageSize = 80
)

// vetAgentRequest 校验并（必要时）原地修正一条直通请求；返回错误则拒绝转发，错误信息面向客户端。
func vetAgentRequest(sm *session.Manager, env *gatewayv1.GatewayEnvelope) error {
	switch payload := env.GetPayload().(type) {
	case nil:
		return errors.New("agent_request payload is required")

	// ---- 普通直通臂（无门控） ----
	case *gatewayv1.GatewayEnvelope_HistoryList:
		clampHistoryList(payload.HistoryList)
		return nil
	case *gatewayv1.GatewayEnvelope_HistoryGet,
		*gatewayv1.GatewayEnvelope_HistoryRename,
		*gatewayv1.GatewayEnvelope_HistoryDelete,
		*gatewayv1.GatewayEnvelope_HistoryPrefix,
		*gatewayv1.GatewayEnvelope_HistoryPin,
		*gatewayv1.GatewayEnvelope_HistoryShareGet,
		*gatewayv1.GatewayEnvelope_HistoryShareSet,
		*gatewayv1.GatewayEnvelope_HistoryWorkdirs,
		*gatewayv1.GatewayEnvelope_HistoryBranch,
		*gatewayv1.GatewayEnvelope_ProviderList,
		*gatewayv1.GatewayEnvelope_ProviderModels,
		*gatewayv1.GatewayEnvelope_SettingsGet,
		*gatewayv1.GatewayEnvelope_SettingsUpdate,
		*gatewayv1.GatewayEnvelope_SettingsResetSshKnownHost,
		*gatewayv1.GatewayEnvelope_SkillFilesList,
		*gatewayv1.GatewayEnvelope_SkillMetadataRead,
		*gatewayv1.GatewayEnvelope_SkillTextRead,
		*gatewayv1.GatewayEnvelope_SkillManage,
		*gatewayv1.GatewayEnvelope_FileMentionList,
		*gatewayv1.GatewayEnvelope_UploadedImagePreview,
		*gatewayv1.GatewayEnvelope_MemoryManage,
		*gatewayv1.GatewayEnvelope_CronManage,
		*gatewayv1.GatewayEnvelope_FsRoots,
		*gatewayv1.GatewayEnvelope_FsListDirs,
		*gatewayv1.GatewayEnvelope_FsCreateProjectFolder,
		*gatewayv1.GatewayEnvelope_FsList,
		*gatewayv1.GatewayEnvelope_FsWriteText,
		*gatewayv1.GatewayEnvelope_FsCreateDir,
		*gatewayv1.GatewayEnvelope_FsRename,
		*gatewayv1.GatewayEnvelope_FsDelete,
		*gatewayv1.GatewayEnvelope_FsReadEditableText,
		*gatewayv1.GatewayEnvelope_FsReadWorkspaceImage,
		*gatewayv1.GatewayEnvelope_ChatQueue:
		return nil

	// ---- 带功能门控 / 限额的直通臂 ----
	case *gatewayv1.GatewayEnvelope_GitRequest:
		action := strings.TrimSpace(payload.GitRequest.GetAction())
		if gitActionIsWrite(action) && !sm.WebGitEnabled() {
			return errors.New("web git is disabled in desktop Remote settings")
		}
		return nil
	case *gatewayv1.GatewayEnvelope_TerminalRequest:
		req := payload.TerminalRequest
		action := strings.TrimSpace(req.GetAction())
		if !shared.TerminalRequestAllowed(sm, action, strings.TrimSpace(req.GetSessionId())) {
			return errors.New(shared.TerminalPermissionError(action))
		}
		return nil
	case *gatewayv1.GatewayEnvelope_SftpRequest:
		if !sm.WebSshTerminalEnabled() {
			return errors.New("web SSH SFTP is disabled in desktop Remote settings")
		}
		return nil
	case *gatewayv1.GatewayEnvelope_TunnelMutation:
		if !sm.WebTunnelsEnabled() {
			return errors.New("web tunnels are disabled in desktop Remote settings")
		}
		return nil
	case *gatewayv1.GatewayEnvelope_ManagedProcessRequest:
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

// gitActionIsWrite 判定 git 直通请求是否为写操作：写操作受桌面端 Remote 设置
// enable_web_git 门控，读操作（status/log/diff 等）始终放行。
func gitActionIsWrite(action string) bool {
	switch action {
	case "clone", "init", "switch_branch", "create_branch", "stage", "stage_all", "unstage", "unstage_all", "discard", "discard_all", "add_to_gitignore", "commit", "fetch", "pull", "set_remote", "push", "delete_branch", "rename_branch", "stash_push", "stash_pop":
		return true
	default:
		return false
	}
}

// clampHistoryList 施加与 v1 相同的分页默认值与上限。
func clampHistoryList(req *gatewayv1.HistoryListRequest) {
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
