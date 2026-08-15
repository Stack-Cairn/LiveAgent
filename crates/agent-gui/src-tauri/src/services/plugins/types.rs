use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

fn default_schema_version() -> u32 {
    1
}

fn default_runtime_scope() -> PluginRuntimeScope {
    PluginRuntimeScope::Workspace
}

fn default_timeout_ms() -> u64 {
    30_000
}

fn default_fuel() -> u64 {
    50_000_000
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginPublisher {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub key_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginEngines {
    #[serde(default)]
    pub liveagent: Option<String>,
    #[serde(default)]
    pub plugin_api: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PluginRuntimeKind {
    WasiCommand,
    Process,
    Declarative,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginRuntime {
    pub kind: PluginRuntimeKind,
    #[serde(default)]
    pub entry: Option<String>,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default = "default_runtime_scope")]
    pub scope: PluginRuntimeScope,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
    #[serde(default = "default_fuel")]
    pub fuel: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PluginRuntimeScope {
    Application,
    Workspace,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginPermissionRequest {
    pub id: String,
    #[serde(default)]
    pub paths: Vec<String>,
    #[serde(default)]
    pub origins: Vec<String>,
    #[serde(default)]
    pub keys: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginToolContribution {
    pub id: String,
    pub model_name: String,
    #[serde(default)]
    pub title: String,
    pub description: String,
    pub input_schema: Value,
    #[serde(default)]
    pub output_schema: Option<Value>,
    pub handler: String,
    #[serde(default)]
    pub read_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginPromptSectionContribution {
    pub id: String,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub position: Option<String>,
    #[serde(default)]
    pub max_tokens: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PluginHookEvent {
    AgentStart,
    TurnStart,
    MessageStart,
    MessageEnd,
    ToolExecutionStart,
    ToolExecutionEnd,
    TurnEnd,
    AgentEnd,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginHookContribution {
    pub id: String,
    pub event: PluginHookEvent,
    #[serde(default = "default_true")]
    pub observe_only: bool,
    pub handler: String,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginSettingsContribution {
    pub id: String,
    pub schema: Value,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginContributions {
    #[serde(default)]
    pub tools: Vec<PluginToolContribution>,
    #[serde(default)]
    pub prompt_sections: Vec<PluginPromptSectionContribution>,
    #[serde(default)]
    pub hooks: Vec<PluginHookContribution>,
    #[serde(default)]
    pub settings: Vec<PluginSettingsContribution>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginDependencies {
    #[serde(default)]
    pub capabilities: BTreeMap<String, String>,
    #[serde(default)]
    pub plugins: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginProvides {
    #[serde(default)]
    pub capabilities: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginManifest {
    #[serde(default, rename = "$schema", skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: String,
    pub publisher: PluginPublisher,
    pub engines: PluginEngines,
    pub runtime: PluginRuntime,
    #[serde(default)]
    pub permissions: Vec<PluginPermissionRequest>,
    #[serde(default)]
    pub requires: PluginDependencies,
    #[serde(default)]
    pub provides: PluginProvides,
    #[serde(default)]
    pub contributes: PluginContributions,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConversationPromptPluginRequest {
    pub workspace: String,
    pub slug: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub instructions: String,
    #[serde(default)]
    pub max_tokens: Option<u32>,
    #[serde(default)]
    pub replace: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PluginLifecyclePhase {
    Installed,
    Blocked,
    Active,
    Disabled,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PluginTrustLevel {
    IntegrityVerified,
    UnsignedDeveloper,
    FullTrustProcess,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PluginInventoryItem {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub publisher: PluginPublisher,
    pub package_hash: String,
    pub generation: i64,
    pub runtime: PluginRuntime,
    pub permissions: Vec<PluginPermissionRequest>,
    pub granted_permissions: Vec<String>,
    pub contributes: PluginContributions,
    pub enabled: bool,
    pub phase: PluginLifecyclePhase,
    pub trust_level: PluginTrustLevel,
    pub blocked_reason: Option<String>,
    pub last_error: Option<String>,
    pub installed_at: i64,
    pub updated_at: i64,
    pub config: Value,
    pub config_revision: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PluginSnapshotTool {
    pub plugin_id: String,
    pub plugin_version: String,
    pub package_hash: String,
    pub generation: i64,
    pub contribution: PluginToolContribution,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PluginSnapshotPromptSection {
    pub plugin_id: String,
    pub plugin_version: String,
    pub package_hash: String,
    pub generation: i64,
    pub id: String,
    pub content: String,
    pub position: Option<String>,
    pub max_tokens: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PluginSnapshotHook {
    pub plugin_id: String,
    pub plugin_version: String,
    pub package_hash: String,
    pub generation: i64,
    pub contribution: PluginHookContribution,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PluginTurnSnapshot {
    pub revision: String,
    pub workspace: String,
    pub tools: Vec<PluginSnapshotTool>,
    pub prompt_sections: Vec<PluginSnapshotPromptSection>,
    pub hooks: Vec<PluginSnapshotHook>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PluginInvocationRequest {
    pub protocol_version: u32,
    pub plugin_id: String,
    pub plugin_version: String,
    pub package_hash: String,
    pub generation: i64,
    pub contribution_id: String,
    pub handler: String,
    pub arguments: Value,
    pub workspace: String,
    pub config: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginInvocationResult {
    pub content: Vec<PluginInvocationContent>,
    #[serde(default)]
    pub details: Value,
    #[serde(default)]
    pub is_error: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum PluginInvocationContent {
    Text { text: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PluginHookDispatchRequest {
    pub event: PluginHookEvent,
    pub workspace: String,
    pub snapshot_revision: String,
    pub hooks: Vec<PluginSnapshotHook>,
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PluginHookDispatchResult {
    pub plugin_id: String,
    pub hook_id: String,
    pub success: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PluginConfigUpdate {
    pub plugin_id: String,
    pub workspace: Option<String>,
    pub expected_revision: i64,
    pub config: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PluginInstallOptions {
    #[serde(default)]
    pub allow_unsigned: bool,
    #[serde(default)]
    pub allow_full_trust: bool,
    #[serde(default)]
    pub granted_permissions: Vec<String>,
}
