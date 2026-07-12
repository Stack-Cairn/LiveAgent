//! Skills 模块对外响应 DTO 与内部数据类型。

use serde::Serialize;
use std::path::PathBuf;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemListSkillFilesResponse {
    pub root_dir: String,
    pub paths: Vec<String>,
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
pub struct SystemReadSkillTextResponse {
    pub content: String,
    pub truncated: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SystemReadSkillMetadataResponse {
    pub name: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SystemSkillSourceMetadata {
    pub registry: String,
    pub slug: String,
    pub version: Option<String>,
    pub published_at: Option<u64>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SystemClawHubSkillCard {
    pub slug: String,
    pub display_name: String,
    pub summary: String,
    pub latest_version: Option<String>,
    pub downloads: u64,
    pub stars: u64,
    pub installs_current: u64,
    pub updated_at: Option<u64>,
    pub owner_handle: Option<String>,
    pub web_url: Option<String>,
    pub download_url: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SystemSkillSummary {
    pub name: String,
    pub description: String,
    pub target: String,
    pub skill_file: String,
    pub base_dir: String,
    pub source: Option<SystemSkillSourceMetadata>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SystemSkillInvalidEntry {
    pub path: String,
    pub error: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SystemSkillInstallResult {
    pub name: String,
    pub target: String,
    pub backup: Option<String>,
    pub skill_file: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SystemSkillValidationResponse {
    pub name: String,
    pub target: String,
    pub ok: bool,
    pub errors: Vec<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SystemSkillPackageResponse {
    pub name: String,
    pub target: String,
    pub archive: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SystemSkillDeleteResponse {
    pub name: String,
    pub target: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SystemBuiltinSkillSeedResponse {
    pub name: String,
    pub target: String,
    pub action: String,
    pub backup: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SystemExternalSkillEntry {
    pub name: String,
    pub description: String,
    /// 技能目录的绝对路径，可直接作为 install 动作的 `source`。
    pub base_dir: String,
    pub skill_file: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SystemExternalToolScan {
    pub tool: String,
    pub root_dir: String,
    pub exists: bool,
    pub skills: Vec<SystemExternalSkillEntry>,
    pub errors: Vec<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SystemSkillInstallJobSnapshot {
    pub job_id: String,
    pub phase: String,
    pub source: String,
    pub label: Option<String>,
    pub slug: Option<String>,
    pub version: Option<String>,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub message: Option<String>,
    pub error: Option<String>,
    pub installed: Option<Vec<SystemSkillInstallResult>>,
    pub started_at: u64,
    pub updated_at: u64,
    pub finished_at: Option<u64>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemManageSkillResponse {
    pub action: String,
    pub root_dir: String,
    pub path: Option<String>,
    pub content: Option<String>,
    pub truncated: Option<bool>,
    pub start_line: Option<usize>,
    pub num_lines: Option<usize>,
    pub skills: Option<Vec<SystemSkillSummary>>,
    pub invalid: Option<Vec<SystemSkillInvalidEntry>>,
    pub installed: Option<Vec<SystemSkillInstallResult>>,
    pub created: Option<SystemSkillInstallResult>,
    pub validation: Option<SystemSkillValidationResponse>,
    pub package: Option<SystemSkillPackageResponse>,
    pub deleted: Option<SystemSkillDeleteResponse>,
    pub install_job: Option<SystemSkillInstallJobSnapshot>,
    pub clawhub_results: Option<Vec<SystemClawHubSkillCard>>,
    pub clawhub_next_cursor: Option<String>,
    pub clawhub_slug: Option<String>,
    pub clawhub_download_url: Option<String>,
    pub external: Option<Vec<SystemExternalToolScan>>,
}

impl SystemManageSkillResponse {
    pub(crate) fn base(action: String, root_dir: String) -> Self {
        Self {
            action,
            root_dir,
            ..Self::default()
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct SkillMetadata {
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) metadata_file: PathBuf,
}

#[derive(Debug, Clone)]
pub(crate) struct GithubSource {
    pub(crate) owner: String,
    pub(crate) repo: String,
    pub(crate) git_ref: String,
    pub(crate) subpath: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct SkillValidationResult {
    pub(crate) ok: bool,
    pub(crate) errors: Vec<String>,
    pub(crate) metadata: Option<SkillMetadata>,
}
