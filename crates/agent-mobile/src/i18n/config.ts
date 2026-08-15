import { createHostTranslations, type Locale } from "@liveagent/ui/i18n/hostTranslations";

export type { Locale } from "@liveagent/ui/i18n/hostTranslations";
export {
  DEFAULT_LOCALE,
  detectSystemLocale,
  normalizeLocale,
  SUPPORTED_LOCALES,
} from "@liveagent/ui/i18n/hostTranslations";

/**
 * Host translation overrides. Shared, host-neutral messages live in agent-ui.
 */
export const WEBUI_TRANSLATION_OVERRIDES: Record<Locale, Record<string, string>> = {
  "zh-CN": {
    "chat.runtime.settingsSyncTitle": "正在同步桌面端设置",
    "chat.runtime.protocolIncompatible":
      "桌面端版本不支持可靠聊天同步。请更新 LiveAgent 桌面端后再使用 WebUI 聊天。",
    "chat.runtime.protocolIncompatiblePlaceholder": "请先更新 LiveAgent 桌面端",
    "chat.queue.moveDown": "下移",
    "chat.upload.maxFilesIgnored": "最多上传 {max} 个文件，已忽略 {count} 个额外文件",
    "projectTools.sshLocalForwardHelp":
      "仅监听桌面端本机 127.0.0.1；本地端口留空或填 0 自动分配，远端主机留空默认 SSH 服务器自身的 127.0.0.1",
    "projectTools.sshLocalForwardListening": "正在监听（仅桌面端本机）",
    "settings.navAgentManagement": "多客户端管理",
    "settings.devicesTitle": "多客户端管理",
    "settings.devicesDesc": "管理连接到此网关的 Agent 及其独立凭证",
    "settings.devicesRefresh": "刷新",
    "settings.devicesFilterAll": "全部",
    "settings.devicesFilterOnline": "在线",
    "settings.devicesFilterOffline": "离线",
    "settings.devicesFilterEmpty": "没有符合条件的客户端",
    "settings.devicesFilterEmptyDesc": "请选择其他状态或刷新后重试。",
    "settings.devicesLoginTitle": "验证网关 Token",
    "settings.devicesLoginDesc": "当前登录信息不可用，请重新输入网关 Token。",
    "settings.devicesGatewayToken": "网关 Token",
    "settings.devicesLogin": "验证",
    "settings.devicesAdd": "新增客户端",
    "settings.devicesAddTitle": "新增客户端",
    "settings.devicesAddDesc": "填写客户端自动生成的 Agent ID，并签发独立访问凭证。",
    "settings.devicesName": "客户端名称",
    "settings.devicesNamePlaceholder": "可选，例如办公室电脑",
    "settings.devicesAgentId": "Agent ID",
    "settings.devicesAgentIdPlaceholder": "粘贴客户端自动生成的 agent-UUID",
    "settings.devicesIssueShort": "签发",
    "settings.devicesRotate": "轮换",
    "settings.devicesRotateTitle": "轮换客户端凭证？",
    "settings.devicesRotateDesc":
      "轮换会立即断开当前客户端，旧凭证无法重连，新凭证明文仅显示一次。",
    "settings.devicesEditName": "编辑",
    "settings.devicesIssuedTitle": "客户端凭证已签发",
    "settings.devicesTokenOnce":
      "该令牌可持续用于客户端连接，但明文仅显示一次，请立即复制并妥善保存。",
    "settings.devicesEmpty": "暂无已登记客户端",
    "settings.devicesEmptyDesc": "连接客户端，或点击新增客户端签发独立凭证。",
    "settings.devicesLoading": "正在加载客户端…",
    "settings.devicesOnlineStatus": "在线",
    "settings.devicesOfflineStatus": "离线",
    "settings.devicesUnknownStatus": "状态确认中",
    "settings.devicesIndependentTokenIssued": "已签发独立凭证",
    "settings.devicesIndependentTokenMissing": "未签发独立凭证",
    "settings.devicesDelete": "删除",
    "settings.devicesDeleteTitle": "删除客户端？",
    "settings.devicesDeleteDesc":
      "将删除整条记录、使独立凭证失效并断开连接；使用共享网关 Token 的客户端可能自动重新登记：",
    "settings.devicesPage": "页码",
    "settings.devicesPrevious": "上一页",
    "settings.devicesNext": "下一页",
    "settings.devicesLoadFailed": "加载客户端列表失败。",
    "settings.devicesIssueFailed": "签发客户端凭证失败。",
    "settings.devicesNameUpdateFailed": "修改客户端名称失败。",
    "settings.devicesDeleteFailed": "删除客户端失败。",
    "settings.devicesTokenRequired": "请输入网关 Token。",
    "settings.devicesAgentRequired": "请输入 Agent ID。",
    "settings.devicesAgentInvalid": "Agent ID 必须是客户端自动生成的 agent-UUIDv4。",
    "settings.memoryOrganizerBackToList": "返回历史列表",
    "settings.systemProxyDesc":
      "生效范围：桌面端本地命令环境变量（Bash / 后台任务 / 自动化脚本）、勾选“使用应用代理”的供应商请求、Hook / Cron HTTP 任务、聊天图片加载、更新检查与技能下载。",
    "settings.workdirDesc": "选择这个项目的文件夹。文件工具会在所选项目目录内读写/搜索。",
    "settings.workdirPickerTitle": "选择项目文件夹",
    "settings.filePickerTitle": "选择文件",
    "settings.filePickerDesc": "从桌面设备中选择一个文件",
    "settings.pathPickerPathLabel": "路径",
    "settings.emptyDir": "此目录为空",
    "settings.select": "选择",
    "settings.loadingDirs": "正在加载目录…",
    "settings.dirLoadFailed": "读取目录失败：",
    "settings.noSubdirs": "此目录下没有子目录",
    "settings.tooManyDirs": "目录过多，已截断显示",
    "settings.createFolder": "新建文件夹",
    "settings.newFolderNamePlaceholder": "新文件夹名称",
    "settings.newFolderSelectParentFirst": "先选择父目录",
    "settings.createFolderFailed": "新建文件夹失败",
    "settings.remoteAgentIdPlaceholder": "例如：macbook-pro",
    "settings.remoteAgentIdHint": "本地 Agent 的唯一标识，在 WebUI 中显示，留空则自动使用主机名",
    "settings.remoteWebTerminalHint":
      "由桌面端 Remote 设置控制。开启后，已登录 WebUI 可启动并控制本机项目终端。",
    "settings.remoteWebSshTerminalHint":
      "由桌面端 Remote 设置控制。开启后，已登录 WebUI 可使用本机保存的 SSH 配置创建和控制远程交互式终端。",
    "settings.remoteWebGitHint":
      "由桌面端 Remote 设置控制。开启后，已登录 WebUI 可对本机项目执行分支、暂存、提交和同步操作。",
    "settings.remoteWebTunnelsHint":
      "由桌面端 Remote 设置控制。开启后，已登录 WebUI 可为 localhost 或 IP 地址 HTTP 服务创建和关闭临时访问链接。",
    "settings.remoteHeartbeatHint":
      "与 Gateway 连接的保活心跳间隔（生效范围 10-60 秒），用于维持连接和检测在线状态",
    "settings.remoteInfoBanner":
      "启用后，本地 LiveAgent 将通过 WebSocket（v2 协议）连接云端 Gateway。你可以在浏览器中通过 WebUI 远程发送 Chat 消息、管理 Cron 任务和查看历史记录。所有工具执行仍在本地完成，远程端仅转发指令和结果。",
  },
  "en-US": {
    "chat.runtime.settingsSyncTitle": "Syncing desktop settings",
    "chat.runtime.protocolIncompatible":
      "This desktop version does not support reliable chat sync. Update LiveAgent desktop before using WebUI chat.",
    "chat.runtime.protocolIncompatiblePlaceholder": "Update LiveAgent desktop to continue",
    "chat.queue.moveDown": "Move down",
    "chat.upload.maxFilesIgnored": "Upload up to {max} files; {count} extra files were ignored",
    "projectTools.sshLocalForwardHelp":
      "Listens on the desktop machine's 127.0.0.1 only. Leave the local port empty or 0 for auto-assign; leave the remote host empty for 127.0.0.1 on the SSH server.",
    "projectTools.sshLocalForwardListening": "Listening on the desktop machine only",
    "settings.navAgentManagement": "Multi-client Management",
    "settings.devicesTitle": "Multi-client Management",
    "settings.devicesDesc": "Manage Agents connected to this Gateway and their credentials",
    "settings.devicesRefresh": "Refresh",
    "settings.devicesFilterAll": "All",
    "settings.devicesFilterOnline": "Online",
    "settings.devicesFilterOffline": "Offline",
    "settings.devicesFilterEmpty": "No matching clients",
    "settings.devicesFilterEmptyDesc": "Choose another status or refresh and try again.",
    "settings.devicesLoginTitle": "Verify Gateway Token",
    "settings.devicesLoginDesc":
      "The current login is unavailable. Enter the Gateway Token again to continue.",
    "settings.devicesGatewayToken": "Gateway Token",
    "settings.devicesLogin": "Verify",
    "settings.devicesAdd": "Add client",
    "settings.devicesAddTitle": "Add client",
    "settings.devicesAddDesc":
      "Enter the Agent ID generated by the client and issue an independent credential.",
    "settings.devicesName": "Client name",
    "settings.devicesNamePlaceholder": "Optional, for example Office desktop",
    "settings.devicesAgentId": "Agent ID",
    "settings.devicesAgentIdPlaceholder": "Paste the agent-UUID generated by the client",
    "settings.devicesIssueShort": "Issue",
    "settings.devicesRotate": "Rotate",
    "settings.devicesRotateTitle": "Rotate client credential?",
    "settings.devicesRotateDesc":
      "Rotation immediately disconnects the client. The old credential cannot reconnect, and the new plaintext is shown once.",
    "settings.devicesEditName": "Edit",
    "settings.devicesIssuedTitle": "Client credential issued",
    "settings.devicesTokenOnce":
      "This token can be reused for client connections, but its plaintext is shown only once. Copy and store it now.",
    "settings.devicesEmpty": "No registered clients",
    "settings.devicesEmptyDesc":
      "Connect a client or select Add client to issue an independent credential.",
    "settings.devicesLoading": "Loading clients…",
    "settings.devicesOnlineStatus": "Online",
    "settings.devicesOfflineStatus": "Offline",
    "settings.devicesUnknownStatus": "Checking status",
    "settings.devicesIndependentTokenIssued": "Independent credential issued",
    "settings.devicesIndependentTokenMissing": "No independent credential",
    "settings.devicesDelete": "Delete",
    "settings.devicesDeleteTitle": "Delete client?",
    "settings.devicesDeleteDesc":
      "This deletes the record, invalidates its credential, and closes its connection. A client using the shared Gateway Token may register again automatically:",
    "settings.devicesPage": "Page",
    "settings.devicesPrevious": "Previous",
    "settings.devicesNext": "Next",
    "settings.devicesLoadFailed": "Failed to load clients.",
    "settings.devicesIssueFailed": "Failed to issue client credential.",
    "settings.devicesNameUpdateFailed": "Failed to update the client name.",
    "settings.devicesDeleteFailed": "Failed to delete the client.",
    "settings.devicesTokenRequired": "Enter the Gateway Token.",
    "settings.devicesAgentRequired": "Enter an Agent ID.",
    "settings.devicesAgentInvalid": "Agent ID must be an agent-UUIDv4 generated by the client.",
    "settings.memoryOrganizerBackToList": "Back to history list",
    "settings.systemProxyDesc":
      "Applies to: local command environment on the desktop (Bash / background tasks / automation scripts), providers with “Use app proxy” checked, Hook / Cron HTTP tasks, chat image loading, update checks and skill downloads.",
    "settings.workdirDesc":
      "Choose this project's folder. File tools read/write/search within the selected project directory.",
    "settings.workdirPickerTitle": "Select Project Folder",
    "settings.filePickerTitle": "Select File",
    "settings.filePickerDesc": "Pick a file from the desktop device",
    "settings.pathPickerPathLabel": "Path",
    "settings.emptyDir": "This directory is empty",
    "settings.select": "Select",
    "settings.loadingDirs": "Loading directories…",
    "settings.dirLoadFailed": "Failed to read directory: ",
    "settings.noSubdirs": "No subdirectories",
    "settings.tooManyDirs": "Too many directories, results truncated",
    "settings.createFolder": "New Folder",
    "settings.newFolderNamePlaceholder": "New folder name",
    "settings.newFolderSelectParentFirst": "Select a parent folder first",
    "settings.createFolderFailed": "Failed to create folder",
    "settings.remoteAgentIdPlaceholder": "e.g. macbook-pro",
    "settings.remoteAgentIdHint":
      "Unique identifier for this Agent shown in WebUI. Leave empty to use hostname",
    "settings.remoteWebTerminalHint":
      "Controlled by the desktop Remote settings. When enabled, authenticated WebUI clients can start and control local project terminals.",
    "settings.remoteWebSshTerminalHint":
      "Controlled by the desktop Remote settings. When enabled, authenticated WebUI clients can create and control remote interactive terminals using SSH profiles saved on the desktop.",
    "settings.remoteWebGitHint":
      "Controlled by the desktop Remote settings. When enabled, authenticated WebUI clients can run branch, stage, commit, and sync operations on local projects.",
    "settings.remoteWebTunnelsHint":
      "Controlled by the desktop Remote settings. When enabled, authenticated WebUI clients can create and close temporary links for localhost or IP-address HTTP services.",
    "settings.remoteHeartbeatHint":
      "Keepalive heartbeat interval for the Gateway connection (effective range 10-60 seconds), used to maintain the connection and detect online status",
    "settings.remoteInfoBanner":
      "When enabled, the local LiveAgent connects to the cloud Gateway over WebSocket (protocol v2). You can remotely send Chat messages, manage Cron tasks, and view history through the WebUI in your browser. All tool execution remains local — the remote end only relays commands and results.",
  },
};

export const { translations, t } = createHostTranslations(WEBUI_TRANSLATION_OVERRIDES);
