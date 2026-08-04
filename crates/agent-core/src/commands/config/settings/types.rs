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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSettingsPayload {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub gateway_url: String,
    #[serde(default = "default_remote_gateway_port", alias = "grpcPort")]
    pub gateway_port: u16,
    #[serde(default)]
    pub token: String,
    #[serde(default)]
    pub agent_id: String,
    #[serde(default = "default_remote_auto_reconnect")]
    pub auto_reconnect: bool,
    #[serde(default = "default_remote_heartbeat_interval")]
    pub heartbeat_interval: u64,
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
