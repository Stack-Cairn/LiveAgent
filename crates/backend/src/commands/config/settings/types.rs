#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsLoadResponse {
    pub providers: Option<Value>,
    pub system: Option<Value>,
    pub mcp: Option<Value>,
    pub agents: Option<Value>,
    pub ssh: Option<Value>,
    pub remote: Option<Value>,
    pub memory: Option<Value>,
    pub default_workdir: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshPatchApplyResponse {
    pub ssh: Value,
    pub conflict: Option<String>,
}

/// 后端的远程访问控制设置：门控「连过来的远程前端能干什么」。
///
/// 这里**没有**「连到哪个 Gateway」——桌面端自己就是后端，不再外拨。
/// 旧库里遗留的 gatewayUrl/token/agentId 等键读到就忽略（serde 默认行为），
/// 不迁移、不报错，下次保存时自然被覆盖掉。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSettingsPayload {
    /// 远程访问总开关：关掉后下面几项一律不生效。
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub enable_web_terminal: bool,
    #[serde(default)]
    pub enable_web_ssh_terminal: bool,
    #[serde(default)]
    pub enable_web_git: bool,
    #[serde(default)]
    pub enable_web_tunnels: bool,
}
#[derive(Debug, Clone)]
pub(crate) struct RuntimeSshProxyConfig {
    pub proxy_type: String,
    pub url: String,
    pub port: i64,
    pub username: String,
    pub password: String,
    pub password_configured: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct RuntimeSshHostConfig {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_type: String,
    pub password: String,
    pub private_key: String,
    pub private_key_path: String,
    pub private_key_passphrase: String,
    pub proxy: RuntimeSshProxyConfig,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RuntimeSshKnownHostStatus {
    Known,
    Unknown,
    Changed { stored_fingerprint: String },
}

#[derive(Debug, Clone)]
pub(crate) struct RuntimeSshKnownHostKey {
    pub host: String,
    pub port: u16,
    pub key_type: String,
    pub key_base64: String,
    pub fingerprint_sha256: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshKnownHostResetResponse {
    pub deleted: usize,
}
