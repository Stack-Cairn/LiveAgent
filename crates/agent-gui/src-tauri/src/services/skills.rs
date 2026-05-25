use chrono::Utc;
use reqwest::blocking::Client as HttpClient;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use uuid::Uuid;
use walkdir::WalkDir;
use zip::write::FileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

const SKILL_READ_MAX_BYTES: usize = 200 * 1024; // 200KB
const DEFAULT_SKILL_READ_LENGTH_LINES: usize = 200;
const DEFAULT_SKILL_GLOB_MAX_RESULTS: usize = 2000;
const SKILL_METADATA_MAX_BYTES: usize = 200 * 1024; // 200KB
const MAX_SKILL_NAME_LENGTH: usize = 64;
const MAX_SKILL_DESCRIPTION_LENGTH: usize = 1024;
const MAX_SKILL_INSTALL_FILES: usize = 2000;
const MAX_SKILL_INSTALL_BYTES: u64 = 50 * 1024 * 1024;
const MAX_SKILL_FILE_BYTES: u64 = 10 * 1024 * 1024;
const DEFAULT_GITHUB_REF: &str = "main";
const CLAWHUB_API_BASE: &str = "https://clawhub.ai";
const DEFAULT_CLAWHUB_SEARCH_LIMIT: usize = 10;
const MAX_CLAWHUB_SEARCH_LIMIT: usize = 20;
const NON_ENGLISH_SCRIPT_RANGES: &[(u32, u32)] = &[
    (0x0370, 0x03FF),   // Greek
    (0x0400, 0x052F),   // Cyrillic
    (0x0590, 0x05FF),   // Hebrew
    (0x0600, 0x06FF),   // Arabic
    (0x0750, 0x077F),   // Arabic Supplement
    (0x08A0, 0x08FF),   // Arabic Extended-A
    (0x0900, 0x0DFF),   // Indic scripts
    (0x0E00, 0x0E7F),   // Thai
    (0x0E80, 0x0EFF),   // Lao
    (0x0F00, 0x0FFF),   // Tibetan
    (0x1000, 0x109F),   // Myanmar
    (0x10A0, 0x10FF),   // Georgian
    (0x1100, 0x11FF),   // Hangul Jamo
    (0x1780, 0x17FF),   // Khmer
    (0x3040, 0x30FF),   // Hiragana and Katakana
    (0x3130, 0x318F),   // Hangul Compatibility Jamo
    (0x31F0, 0x31FF),   // Katakana Phonetic Extensions
    (0x3400, 0x4DBF),   // CJK Extension A
    (0x4E00, 0x9FFF),   // CJK Unified Ideographs
    (0xAC00, 0xD7AF),   // Hangul Syllables
    (0xF900, 0xFAFF),   // CJK Compatibility Ideographs
    (0xFF00, 0xFFEF),   // Halfwidth and Fullwidth Forms
    (0x20000, 0x2FA1F), // CJK Extensions and compatibility supplements
];

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

#[derive(Debug, Clone)]
struct SkillInstallJobState {
    job_id: String,
    phase: String,
    source: String,
    label: Option<String>,
    slug: Option<String>,
    version: Option<String>,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    message: Option<String>,
    error: Option<String>,
    installed: Option<Vec<SystemSkillInstallResult>>,
    started_at: u64,
    updated_at: u64,
    finished_at: Option<u64>,
}

#[derive(Debug, Clone)]
struct SkillInstallProgressUpdate {
    phase: &'static str,
    downloaded_bytes: Option<u64>,
    total_bytes: Option<u64>,
    message: Option<String>,
}

static SKILL_INSTALL_JOBS: OnceLock<Mutex<HashMap<String, SkillInstallJobState>>> = OnceLock::new();

#[derive(Debug, Serialize)]
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
    pub seeded: Option<Vec<SystemBuiltinSkillSeedResponse>>,
    pub install_job: Option<SystemSkillInstallJobSnapshot>,
    pub clawhub_results: Option<Vec<SystemClawHubSkillCard>>,
    pub clawhub_next_cursor: Option<String>,
    pub clawhub_slug: Option<String>,
    pub clawhub_download_url: Option<String>,
}

#[derive(Debug, Clone)]
struct SkillMetadata {
    name: String,
    description: String,
    metadata_file: PathBuf,
}

#[derive(Debug, Clone)]
struct GithubSource {
    owner: String,
    repo: String,
    git_ref: String,
    subpath: Option<String>,
}

#[derive(Debug, Clone)]
struct SkillValidationResult {
    ok: bool,
    errors: Vec<String>,
    metadata: Option<SkillMetadata>,
}

struct BuiltinSkillFile {
    path: &'static str,
    content: &'static str,
}

struct BuiltinSkill {
    name: &'static str,
    files: &'static [BuiltinSkillFile],
}

const SKILLS_INSTALLER_FILES: &[BuiltinSkillFile] = &[
    BuiltinSkillFile {
        path: "SKILL.md",
        content: include_str!("../../prompt/skills/skills-installer/SKILL.md"),
    },
    BuiltinSkillFile {
        path: "references/install-sources.md",
        content: include_str!("../../prompt/skills/skills-installer/references/install-sources.md"),
    },
    BuiltinSkillFile {
        path: "references/safety-and-conflicts.md",
        content: include_str!(
            "../../prompt/skills/skills-installer/references/safety-and-conflicts.md"
        ),
    },
];

const SKILLS_CREATOR_FILES: &[BuiltinSkillFile] = &[
    BuiltinSkillFile {
        path: "SKILL.md",
        content: include_str!("../../prompt/skills/skills-creator/SKILL.md"),
    },
    BuiltinSkillFile {
        path: "references/agent-skill-format.md",
        content: include_str!(
            "../../prompt/skills/skills-creator/references/agent-skill-format.md"
        ),
    },
    BuiltinSkillFile {
        path: "references/authoring-patterns.md",
        content: include_str!(
            "../../prompt/skills/skills-creator/references/authoring-patterns.md"
        ),
    },
];

const BUILTIN_AGENT_SKILLS: &[BuiltinSkill] = &[
    BuiltinSkill {
        name: "skills-installer",
        files: SKILLS_INSTALLER_FILES,
    },
    BuiltinSkill {
        name: "skills-creator",
        files: SKILLS_CREATOR_FILES,
    },
];

fn is_builtin_agent_skill_name(name: &str) -> bool {
    BUILTIN_AGENT_SKILLS
        .iter()
        .any(|skill| skill.name.eq_ignore_ascii_case(name))
}

fn ensure_not_builtin_skill_management_target(name: &str, action: &str) -> Result<(), String> {
    if is_builtin_agent_skill_name(name) {
        return Err(format!(
            "SkillsManager action={action} cannot modify built-in Skill \"{name}\". Built-in Skills are managed by LiveAgent; create or update a separate user Skill instead."
        ));
    }
    Ok(())
}

struct TempDir {
    path: PathBuf,
}

impl TempDir {
    fn new(prefix: &str) -> Result<Self, String> {
        let base = std::env::temp_dir();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let path = base.join(format!("{prefix}-{}-{now}", std::process::id()));
        fs::create_dir_all(&path)
            .map_err(|e| format!("Failed to create temporary directory: {e}"))?;
        Ok(Self { path })
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn skill_install_jobs() -> &'static Mutex<HashMap<String, SkillInstallJobState>> {
    SKILL_INSTALL_JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn install_job_snapshot(job: &SkillInstallJobState) -> SystemSkillInstallJobSnapshot {
    SystemSkillInstallJobSnapshot {
        job_id: job.job_id.clone(),
        phase: job.phase.clone(),
        source: job.source.clone(),
        label: job.label.clone(),
        slug: job.slug.clone(),
        version: job.version.clone(),
        downloaded_bytes: job.downloaded_bytes,
        total_bytes: job.total_bytes,
        message: job.message.clone(),
        error: job.error.clone(),
        installed: job.installed.clone(),
        started_at: job.started_at,
        updated_at: job.updated_at,
        finished_at: job.finished_at,
    }
}

fn prune_old_install_jobs(jobs: &mut HashMap<String, SkillInstallJobState>, now: u64) {
    const RETENTION_MS: u64 = 60 * 60 * 1000;
    jobs.retain(|_, job| {
        job.finished_at
            .map(|finished_at| now.saturating_sub(finished_at) <= RETENTION_MS)
            .unwrap_or(true)
    });
}

fn insert_install_job(job: SkillInstallJobState) -> Result<SystemSkillInstallJobSnapshot, String> {
    let snapshot = install_job_snapshot(&job);
    let mut jobs = skill_install_jobs()
        .lock()
        .map_err(|_| "Failed to lock Skill install jobs".to_string())?;
    prune_old_install_jobs(&mut jobs, now_millis());
    jobs.insert(job.job_id.clone(), job);
    Ok(snapshot)
}

fn update_install_job<F>(job_id: &str, updater: F) -> Result<SystemSkillInstallJobSnapshot, String>
where
    F: FnOnce(&mut SkillInstallJobState),
{
    let mut jobs = skill_install_jobs()
        .lock()
        .map_err(|_| "Failed to lock Skill install jobs".to_string())?;
    let job = jobs
        .get_mut(job_id)
        .ok_or_else(|| format!("Skill install job not found: {job_id}"))?;
    updater(job);
    job.updated_at = now_millis();
    Ok(install_job_snapshot(job))
}

fn get_install_job_snapshot(job_id: &str) -> Result<SystemSkillInstallJobSnapshot, String> {
    let mut jobs = skill_install_jobs()
        .lock()
        .map_err(|_| "Failed to lock Skill install jobs".to_string())?;
    prune_old_install_jobs(&mut jobs, now_millis());
    let job = jobs
        .get(job_id)
        .ok_or_else(|| format!("Skill install job not found: {job_id}"))?;
    Ok(install_job_snapshot(job))
}

pub fn app_storage_dir() -> Result<PathBuf, String> {
    let home =
        dirs::home_dir().ok_or_else(|| "Failed to locate the user home directory".to_string())?;
    let dir = home.join(format!(".{}", env!("CARGO_PKG_NAME")));
    fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create the application directory: {e}"))?;
    Ok(dir)
}

pub fn skills_root_dir() -> Result<PathBuf, String> {
    let dir = app_storage_dir()?.join("skills");
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create the skills directory: {e}"))?;
    fs::canonicalize(&dir).map_err(|e| format!("Failed to resolve the skills directory: {e}"))
}

fn skill_root_display(root: &Path) -> String {
    let raw = root.to_string_lossy();
    #[cfg(windows)]
    {
        if let Some(stripped) = raw.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{}", stripped).replace('\\', "/");
        }
        if let Some(stripped) = raw.strip_prefix(r"\\?\") {
            return stripped.replace('\\', "/");
        }
    }
    raw.replace('\\', "/")
}

fn rel_to_root_str(root: &Path, abs: &Path) -> String {
    abs.strip_prefix(root)
        .unwrap_or(abs)
        .to_string_lossy()
        .replace('\\', "/")
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn is_skill_markdown(path: &Path) -> bool {
    path.file_name()
        .map(|name| name.to_string_lossy().eq_ignore_ascii_case("skill.md"))
        .unwrap_or(false)
}

fn is_readme_markdown(path: &Path) -> bool {
    path.file_name()
        .map(|name| name.to_string_lossy().eq_ignore_ascii_case("README.md"))
        .unwrap_or(false)
}

fn is_skill_json(path: &Path) -> bool {
    path.file_name()
        .map(|name| name.to_string_lossy().eq_ignore_ascii_case("skill.json"))
        .unwrap_or(false)
}

fn standard_metadata_file_for(skill_dir: &Path) -> Option<PathBuf> {
    for name in ["skill.json", "SKILL.md", "skill.md"] {
        let candidate = skill_dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    let entries = fs::read_dir(skill_dir).ok()?;
    for entry in entries.flatten() {
        let candidate = entry.path();
        if candidate.is_file()
            && candidate
                .file_name()
                .map(|name| {
                    let name = name.to_string_lossy();
                    name.eq_ignore_ascii_case("skill.json") || name.eq_ignore_ascii_case("skill.md")
                })
                .unwrap_or(false)
        {
            return Some(candidate);
        }
    }
    None
}

fn is_skill_metadata_candidate(path: &Path) -> bool {
    is_skill_markdown(path) || is_skill_json(path) || is_readme_markdown(path)
}

fn is_archive_path(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.to_ascii_lowercase())
            .as_deref(),
        Some("zip") | Some("skill")
    )
}

fn strip_utf8_bom(input: &str) -> &str {
    input.strip_prefix('\u{feff}').unwrap_or(input)
}

fn unquote_yaml_scalar(raw: &str) -> String {
    let value = raw.trim();
    if value.len() >= 2 {
        let quoted_with_double = value.starts_with('"') && value.ends_with('"');
        let quoted_with_single = value.starts_with('\'') && value.ends_with('\'');
        if quoted_with_double || quoted_with_single {
            return value[1..value.len() - 1].to_string();
        }
    }
    value.to_string()
}

fn normalize_skill_metadata_value(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

fn parse_yaml_top_level_scalar(yaml: &str, key: &str) -> Option<String> {
    if !yaml.contains('\n') {
        return parse_inline_yaml_top_level_scalar(yaml, key);
    }

    let lines: Vec<&str> = yaml.lines().collect();
    let prefix = format!("{key}:");
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        let Some(rest) = line.strip_prefix(&prefix) else {
            i += 1;
            continue;
        };

        let rest = rest.trim();
        if rest == "|" || rest == ">" {
            i += 1;
            let mut block = Vec::new();
            while i < lines.len() {
                let block_line = lines[i];
                let is_indented = block_line
                    .chars()
                    .next()
                    .map(char::is_whitespace)
                    .unwrap_or(false);
                if !is_indented {
                    break;
                }
                block.push(block_line.trim_start().to_string());
                i += 1;
            }
            return Some(block.join("\n"));
        }

        return Some(unquote_yaml_scalar(rest));
    }

    None
}

fn inline_yaml_key_start(yaml: &str, key: &str) -> Option<usize> {
    let prefix = format!("{key}:");
    yaml.match_indices(&prefix).find_map(|(index, _)| {
        let is_boundary = index == 0
            || yaml[..index]
                .chars()
                .next_back()
                .map(char::is_whitespace)
                .unwrap_or(false);
        is_boundary.then_some(index)
    })
}

fn parse_inline_yaml_top_level_scalar(yaml: &str, key: &str) -> Option<String> {
    let start = inline_yaml_key_start(yaml, key)? + key.len() + 1;
    let mut end = yaml.len();
    for other in [
        "name",
        "description",
        "license",
        "allowed-tools",
        "metadata",
    ] {
        if other == key {
            continue;
        }
        if let Some(next) = inline_yaml_key_start(&yaml[start..], other) {
            end = end.min(start + next);
        }
    }
    Some(unquote_yaml_scalar(yaml[start..end].trim()))
}

fn parse_skill_frontmatter_yaml_metadata(yaml: &str) -> SystemReadSkillMetadataResponse {
    let name = parse_yaml_top_level_scalar(yaml, "name");
    let description = parse_yaml_top_level_scalar(yaml, "description");

    SystemReadSkillMetadataResponse {
        name: normalize_skill_metadata_value(name),
        description: normalize_skill_metadata_value(description),
    }
}

fn parse_skill_json_metadata(json_text: &str) -> SystemReadSkillMetadataResponse {
    let Ok(parsed) = serde_json::from_str::<Value>(strip_utf8_bom(json_text)) else {
        return SystemReadSkillMetadataResponse {
            name: None,
            description: None,
        };
    };

    let name = parsed
        .get("name")
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let description = parsed
        .get("description")
        .and_then(Value::as_str)
        .map(ToString::to_string);

    SystemReadSkillMetadataResponse {
        name: normalize_skill_metadata_value(name),
        description: normalize_skill_metadata_value(description),
    }
}

fn empty_skill_metadata_response() -> SystemReadSkillMetadataResponse {
    SystemReadSkillMetadataResponse {
        name: None,
        description: None,
    }
}

fn is_missing_frontmatter_error(error: &str) -> bool {
    error == "Skill frontmatter must start with ---"
}

fn fallback_readme_skill_name(skill_dir: &Path) -> Result<String, String> {
    let raw = skill_dir
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "readme-skill".to_string());
    let normalized = normalize_skill_name(&raw);
    sanitize_skill_name(&normalized)
}

fn first_readme_description_line(content: &str) -> Option<String> {
    strip_utf8_bom(content).lines().find_map(|line| {
        let mut value = line.trim();
        if value.is_empty() {
            return None;
        }
        if value == "---" {
            return None;
        }
        value = value.trim_start_matches('#').trim();
        if value.is_empty() {
            return None;
        }
        let value = value
            .trim_matches(|ch: char| ch == '*' || ch == '_' || ch == '`')
            .trim();
        (!value.is_empty()).then(|| value.to_string())
    })
}

fn fallback_readme_description(readme_file: &Path, name: &str) -> Result<String, String> {
    let content = fs::read_to_string(readme_file)
        .map_err(|e| format!("Failed to read README.md fallback: {e}"))?;
    let description = first_readme_description_line(&content)
        .unwrap_or_else(|| format!("README.md skill instructions for {name}"));
    Ok(description
        .chars()
        .take(MAX_SKILL_DESCRIPTION_LENGTH)
        .collect())
}

fn read_skill_markdown_frontmatter_yaml<R: BufRead>(reader: &mut R) -> Result<String, String> {
    let mut buf = Vec::new();
    let mut yaml = String::new();
    let mut is_first_line = true;

    loop {
        buf.clear();
        let n = reader
            .read_until(b'\n', &mut buf)
            .map_err(|e| format!("Failed to read Skill file: {e}"))?;
        if n == 0 {
            return Err("Skill frontmatter must start with ---".to_string());
        }

        let line = String::from_utf8_lossy(&buf).to_string();
        let line = if is_first_line {
            is_first_line = false;
            strip_utf8_bom(&line).to_string()
        } else {
            line
        };

        if line.trim().is_empty() {
            continue;
        }

        if line.trim() != "---" {
            if let Some((yaml, _body)) = split_inline_frontmatter(&line) {
                return Ok(yaml);
            }
            return Err("Skill frontmatter must start with ---".to_string());
        }
        break;
    }

    let mut found_end = false;
    loop {
        buf.clear();
        let n = reader
            .read_until(b'\n', &mut buf)
            .map_err(|e| format!("Failed to read Skill file: {e}"))?;
        if n == 0 {
            break;
        }

        let line = String::from_utf8_lossy(&buf);
        if yaml.len().saturating_add(line.len()) > SKILL_METADATA_MAX_BYTES {
            return Err(format!(
                "Skill frontmatter is too large, over {} bytes",
                SKILL_METADATA_MAX_BYTES
            ));
        }

        if line.trim() == "---" {
            found_end = true;
            break;
        }
        yaml.push_str(&line);
    }

    if !found_end {
        return Err("Skill frontmatter is missing closing ---".to_string());
    }

    Ok(yaml)
}

fn sanitize_skill_rel_path(input: &str) -> Result<PathBuf, String> {
    let raw = input.trim();
    if raw.is_empty() {
        return Err("Skill path cannot be empty".to_string());
    }

    let path = Path::new(raw);
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(_) | Component::RootDir => {
                return Err(format!("Skill path must be relative: {input}"));
            }
            Component::ParentDir => {
                return Err(format!("Skill path must not contain ..: {input}"));
            }
            Component::CurDir => {}
            Component::Normal(segment) => {
                let segment = segment.to_string_lossy();
                if segment.contains(':') || is_windows_reserved_path_component(&segment) {
                    return Err(format!("Invalid Skill path: {input}"));
                }
                out.push(segment.as_ref());
            }
        }
    }

    if out.as_os_str().is_empty() {
        return Err("Skill path cannot be empty".to_string());
    }

    Ok(out)
}

fn sanitize_skill_child_rel_path(input: &str) -> Result<PathBuf, String> {
    let rel = sanitize_skill_rel_path(input)?;
    if rel
        .components()
        .any(|component| matches!(component, Component::Normal(segment) if segment.to_string_lossy().starts_with('.')))
    {
        return Err(format!("Skill file path must not use hidden control directories: {input}"));
    }
    Ok(rel)
}

fn sanitize_skill_name(input: &str) -> Result<String, String> {
    let name = input.trim();
    if name.is_empty() {
        return Err("Skill name cannot be empty".to_string());
    }
    if name.len() > MAX_SKILL_NAME_LENGTH {
        return Err(format!(
            "Skill name '{name}' is too long; maximum is {MAX_SKILL_NAME_LENGTH}"
        ));
    }
    if !name
        .chars()
        .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
    {
        return Err(format!(
            "Skill name '{name}' must use lowercase letters, digits, and hyphens only"
        ));
    }
    if name.starts_with('-') || name.ends_with('-') || name.contains("--") {
        return Err(format!(
            "Skill name '{name}' cannot start/end with hyphen or contain consecutive hyphens"
        ));
    }
    if is_windows_reserved_path_component(name) {
        return Err(format!("Skill name '{name}' is reserved on Windows"));
    }
    Ok(name.to_string())
}

fn is_windows_reserved_path_component(input: &str) -> bool {
    let stem = input
        .split('.')
        .next()
        .unwrap_or(input)
        .trim_matches(|ch| ch == ' ' || ch == '.')
        .to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit()
            && stem.as_bytes()[3] != b'0')
}

fn normalize_skill_name(raw_name: &str) -> String {
    let mut out = String::new();
    let mut previous_dash = false;
    for ch in raw_name.trim().chars().flat_map(char::to_lowercase) {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() {
            out.push(ch);
            previous_dash = false;
        } else if !previous_dash {
            out.push('-');
            previous_dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

fn title_case_skill_name(skill_name: &str) -> String {
    skill_name
        .split('-')
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_ascii_uppercase(), chars.as_str()),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn yaml_quote(value: &str) -> String {
    let escaped = value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n");
    format!("\"{escaped}\"")
}

fn render_skill_template(name: &str, description: &str, body: Option<&str>) -> String {
    let body = body.map(str::trim).filter(|value| !value.is_empty());
    let rendered_body = body.map_or_else(
        || {
            format!(
                "# {}\n\n## Language Policy\n\n- Write this skill document and every Markdown reference in English only.\n- Translate non-English source notes into English before adding them here.\n- Preserve code identifiers, filenames, commands, URLs, and literal values exactly when needed.\n\n## Workflow\n\n1. Inspect the user's request and gather the required context.\n2. Follow the workflow this skill is meant to capture.\n3. Validate the result and report changed files or outputs.\n",
                title_case_skill_name(name)
            )
        },
        |value| value.to_string(),
    );
    format!(
        "---\nname: {name}\ndescription: {}\n---\n\n{}\n",
        yaml_quote(description),
        rendered_body
    )
}

fn is_non_english_script_char(ch: char) -> bool {
    let codepoint = ch as u32;
    NON_ENGLISH_SCRIPT_RANGES
        .iter()
        .any(|(start, end)| codepoint >= *start && codepoint <= *end)
}

fn first_non_english_script_char(content: &str) -> Option<char> {
    content.chars().find(|ch| is_non_english_script_char(*ch))
}

fn is_markdown_document(rel: &Path) -> bool {
    let is_markdown = rel
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("md"))
        .unwrap_or(false);
    if !is_markdown {
        return false;
    }
    rel.components().count() == 1 || rel.starts_with("references")
}

fn validate_english_markdown_document(path: &Path, rel: &Path, errors: &mut Vec<String>) {
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) => {
            errors.push(format!(
                "Failed to read Markdown documentation {}: {error}",
                rel.to_string_lossy()
            ));
            return;
        }
    };
    if let Some(ch) = first_non_english_script_char(&content) {
        errors.push(format!(
            "Markdown documentation must be written in English only: {} contains non-English script character U+{:04X}",
            rel.to_string_lossy(),
            ch as u32
        ));
    }
}

fn ensure_within_skills_root_existing(root: &Path, target: &Path) -> Result<PathBuf, String> {
    let canon =
        fs::canonicalize(target).map_err(|e| format!("Failed to resolve the Skill file: {e}"))?;
    if !canon.starts_with(root) {
        return Err(format!(
            "Target Skill file is outside the skills root: {}",
            canon.display()
        ));
    }
    Ok(canon)
}

fn should_skip_discovery_path(root: &Path, path: &Path) -> bool {
    let rel = path.strip_prefix(root).unwrap_or(path);
    rel.components().any(|component| match component {
        Component::Normal(segment) => {
            let name = segment.to_string_lossy();
            name.starts_with('.') || name.contains(".backup-") || name.starts_with("backup-")
        }
        _ => false,
    })
}

fn has_skill_metadata_ancestor(root: &Path, path: &Path) -> bool {
    if !path.starts_with(root) {
        return false;
    }
    let mut current = path.parent();
    while let Some(parent) = current {
        if !parent.starts_with(root) {
            break;
        }
        if parent == root {
            break;
        }
        if metadata_file_for(parent).is_some() {
            return true;
        }
        current = parent.parent();
    }
    false
}

fn should_include_metadata_candidate(root: &Path, path: &Path) -> bool {
    if !is_skill_metadata_candidate(path) {
        return false;
    }
    if !is_readme_markdown(path) {
        return true;
    }
    let Some(parent) = path.parent() else {
        return false;
    };
    standard_metadata_file_for(parent).is_none() && !has_skill_metadata_ancestor(root, parent)
}

fn metadata_file_for(skill_dir: &Path) -> Option<PathBuf> {
    if let Some(candidate) = standard_metadata_file_for(skill_dir) {
        return Some(candidate);
    }
    let readme = skill_dir.join("README.md");
    if readme.is_file() {
        return Some(readme);
    }
    let entries = fs::read_dir(skill_dir).ok()?;
    for entry in entries.flatten() {
        let candidate = entry.path();
        if candidate.is_file()
            && candidate
                .file_name()
                .map(|name| {
                    let name = name.to_string_lossy();
                    name.eq_ignore_ascii_case("README.md")
                })
                .unwrap_or(false)
        {
            return Some(candidate);
        }
    }
    None
}

fn is_skill_dir(path: &Path) -> bool {
    path.is_dir() && metadata_file_for(path).is_some()
}

fn read_skill_metadata_from_dir(skill_dir: &Path) -> Result<SkillMetadata, String> {
    let metadata_file = metadata_file_for(skill_dir).ok_or_else(|| {
        format!(
            "No SKILL.md, skill.md, skill.json, or README.md found in {}",
            skill_dir.display()
        )
    })?;
    let metadata = read_skill_metadata_file(&metadata_file)?;
    let name = metadata.name.clone();
    let description = metadata.description.clone();
    if is_readme_markdown(&metadata_file) && name.is_none() && description.is_none() {
        let name = fallback_readme_skill_name(skill_dir)?;
        let description = fallback_readme_description(&metadata_file, &name)?;
        sanitize_skill_name(&name)?;
        return Ok(SkillMetadata {
            name,
            description,
            metadata_file,
        });
    }

    let name = name.ok_or_else(|| format!("Missing skill name in {}", metadata_file.display()))?;
    let description = description
        .ok_or_else(|| format!("Missing skill description in {}", metadata_file.display()))?;
    sanitize_skill_name(&name)?;
    Ok(SkillMetadata {
        name,
        description,
        metadata_file,
    })
}

fn read_skill_metadata_file(target: &Path) -> Result<SystemReadSkillMetadataResponse, String> {
    let md = fs::metadata(target).map_err(|e| format!("Failed to read Skill metadata: {e}"))?;
    if !md.is_file() {
        return Err("Only regular Skill metadata files can be read".to_string());
    }

    if is_skill_json(target) {
        let content =
            fs::read_to_string(target).map_err(|e| format!("Failed to read skill.json: {e}"))?;
        if content.len() > SKILL_METADATA_MAX_BYTES {
            return Err(format!(
                "skill.json is too large, over {} bytes",
                SKILL_METADATA_MAX_BYTES
            ));
        }
        return Ok(parse_skill_json_metadata(&content));
    }

    if !is_skill_markdown(target) && !is_readme_markdown(target) {
        return Err(
            "Skill metadata files only support skill.json / SKILL.md / skill.md / README.md"
                .to_string(),
        );
    }

    let file = fs::File::open(target).map_err(|e| format!("Failed to open Skill file: {e}"))?;
    let mut reader = BufReader::new(file);
    let yaml = match read_skill_markdown_frontmatter_yaml(&mut reader) {
        Ok(yaml) => yaml,
        Err(error) if is_readme_markdown(target) && is_missing_frontmatter_error(&error) => {
            return Ok(empty_skill_metadata_response());
        }
        Err(error) => return Err(error),
    };
    Ok(parse_skill_frontmatter_yaml_metadata(&yaml))
}

fn split_inline_frontmatter(content: &str) -> Option<(String, String)> {
    let rest = content.trim_start().strip_prefix("---")?;
    if rest.trim_start().starts_with('\n') || rest.trim().is_empty() {
        return None;
    }
    let closing = rest.find("---")?;
    let yaml = rest[..closing].trim().to_string();
    let body = rest[closing + 3..].trim_start().to_string();
    Some((yaml, body))
}

pub fn system_list_skill_files_sync() -> Result<SystemListSkillFilesResponse, String> {
    let root = skills_root_dir()?;
    let root_dir = skill_root_display(&root);

    let mut paths = Vec::new();
    let mut truncated = false;
    for entry in WalkDir::new(&root).follow_links(false) {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };

        if should_skip_discovery_path(&root, entry.path()) {
            continue;
        }
        if !entry.file_type().is_file() || !should_include_metadata_candidate(&root, entry.path()) {
            continue;
        }

        if paths.len() >= DEFAULT_SKILL_GLOB_MAX_RESULTS {
            truncated = true;
            break;
        }

        paths.push(rel_to_root_str(&root, entry.path()));
    }

    paths.sort();
    Ok(SystemListSkillFilesResponse {
        root_dir,
        paths,
        truncated,
    })
}

pub fn system_read_skill_metadata_sync(
    path: String,
) -> Result<SystemReadSkillMetadataResponse, String> {
    let root = skills_root_dir()?;
    let rel = sanitize_skill_rel_path(&path)?;
    let target = root.join(rel);
    let target = ensure_within_skills_root_existing(&root, &target)?;
    read_skill_metadata_file(&target)
}

pub fn system_read_skill_text_sync(
    path: String,
    offset: Option<usize>,
    length: Option<usize>,
) -> Result<SystemReadSkillTextResponse, String> {
    let root = skills_root_dir()?;
    read_skill_text_from_root(&root, &path, offset, length)
}

fn read_skill_text_from_root(
    root: &Path,
    path: &str,
    offset: Option<usize>,
    length: Option<usize>,
) -> Result<SystemReadSkillTextResponse, String> {
    let rel = sanitize_skill_rel_path(path)?;
    let target = root.join(rel);
    let target = ensure_within_skills_root_existing(root, &target)?;
    let md =
        fs::metadata(&target).map_err(|e| format!("Failed to read Skill file metadata: {e}"))?;
    if !md.is_file() {
        return Err("Only regular Skill files can be read (not directories)".to_string());
    }

    let offset = offset.unwrap_or(0);
    let length = length.unwrap_or(DEFAULT_SKILL_READ_LENGTH_LINES);

    let file =
        fs::File::open(&target).map_err(|e| format!("Failed to open the Skill file: {e}"))?;
    let mut reader = BufReader::new(file);

    let mut line_idx: usize = 0;
    let mut taken: usize = 0;
    let mut out = String::new();
    let mut truncated = false;
    let mut buf = Vec::new();

    loop {
        buf.clear();
        let n = reader
            .read_until(b'\n', &mut buf)
            .map_err(|e| format!("Failed to read the Skill file: {e}"))?;
        if n == 0 {
            break;
        }

        if line_idx < offset {
            line_idx += 1;
            continue;
        }

        if taken >= length {
            truncated = true;
            break;
        }

        if out.len().saturating_add(buf.len()) > SKILL_READ_MAX_BYTES {
            truncated = true;
            break;
        }

        out.push_str(&String::from_utf8_lossy(&buf));
        line_idx += 1;
        taken += 1;
    }

    Ok(SystemReadSkillTextResponse {
        content: out,
        truncated,
    })
}

fn discover_skill_dirs(root: &Path) -> Vec<PathBuf> {
    let mut root = root.to_path_buf();
    if root.is_file() && is_skill_metadata_candidate(&root) {
        if let Some(parent) = root.parent() {
            root = parent.to_path_buf();
        }
    }

    if root.is_dir() && standard_metadata_file_for(&root).is_some() {
        return vec![root];
    }

    let nested_skills = root.join("skills");
    if nested_skills.is_dir() {
        let candidates = read_child_skill_dirs(&nested_skills);
        if !candidates.is_empty() {
            return candidates;
        }
    }

    if root.is_dir() {
        let candidates = read_child_skill_dirs(&root);
        if !candidates.is_empty() {
            return candidates;
        }
    }

    if is_skill_dir(&root) {
        return vec![root];
    }

    Vec::new()
}

fn read_child_skill_dirs(root: &Path) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let Ok(entries) = fs::read_dir(root) else {
        return candidates;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path
            .file_name()
            .map(|name| {
                let name = name.to_string_lossy();
                name.starts_with('.') || name.contains(".backup-")
            })
            .unwrap_or(false)
        {
            continue;
        }
        if is_skill_dir(&path) {
            candidates.push(path);
        }
    }
    candidates.sort();
    candidates
}

fn read_skill_source_metadata(skill_dir: &Path) -> Option<SystemSkillSourceMetadata> {
    let meta_path = skill_dir.join("_meta.json");
    let content = fs::read_to_string(meta_path).ok()?;
    let value = serde_json::from_str::<Value>(&content).ok()?;
    let slug = value
        .get("slug")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?
        .to_string();
    let version = value
        .get("version")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let published_at = value.get("publishedAt").and_then(Value::as_u64);

    Some(SystemSkillSourceMetadata {
        registry: "clawhub".to_string(),
        slug,
        version,
        published_at,
    })
}

fn write_skill_source_metadata_for_install(
    root: &Path,
    payload: &serde_json::Map<String, Value>,
    installed: &[SystemSkillInstallResult],
) -> Result<(), String> {
    let Some(slug) = object_string(payload, "slug") else {
        return Ok(());
    };
    let version = object_string(payload, "version").map(ToOwned::to_owned);
    let published_at = payload.get("publishedAt").and_then(Value::as_u64);
    let metadata = serde_json::json!({
        "registry": "clawhub",
        "slug": slug,
        "version": version,
        "publishedAt": published_at,
    });
    let bytes = serde_json::to_vec_pretty(&metadata)
        .map_err(|e| format!("Failed to serialize Skill source metadata: {e}"))?;

    for item in installed {
        let target = root.join(&item.name);
        fs::write(target.join("_meta.json"), &bytes)
            .map_err(|e| format!("Failed to write Skill source metadata: {e}"))?;
    }

    Ok(())
}

fn skill_summary_from_dir(root: &Path, skill_dir: &Path) -> Result<SystemSkillSummary, String> {
    let metadata = read_skill_metadata_from_dir(skill_dir)?;
    let skill_file = rel_to_root_str(root, &metadata.metadata_file);
    let base_dir = rel_to_root_str(root, skill_dir);
    Ok(SystemSkillSummary {
        name: metadata.name,
        description: metadata.description,
        target: display_path(skill_dir),
        skill_file,
        base_dir,
        source: read_skill_source_metadata(skill_dir),
    })
}

fn list_installed_skills(
    root: &Path,
) -> Result<(Vec<SystemSkillSummary>, Vec<SystemSkillInvalidEntry>), String> {
    let mut skills = Vec::new();
    let mut invalid = Vec::new();
    let entries = fs::read_dir(root).map_err(|e| format!("Failed to list Skills root: {e}"))?;
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                invalid.push(SystemSkillInvalidEntry {
                    path: root.display().to_string(),
                    error: error.to_string(),
                });
                continue;
            }
        };
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name.contains(".backup-") || !path.is_dir() {
            continue;
        }
        match skill_summary_from_dir(root, &path) {
            Ok(summary) => skills.push(summary),
            Err(error) => invalid.push(SystemSkillInvalidEntry {
                path: display_path(&path),
                error,
            }),
        }
    }
    skills.sort_by(|a, b| a.name.cmp(&b.name));
    Ok((skills, invalid))
}

fn backup_existing_path(
    dest_root: &Path,
    target: &Path,
    skill_name: &str,
) -> Result<PathBuf, String> {
    let backups_root = dest_root.join(".backups");
    fs::create_dir_all(&backups_root)
        .map_err(|e| format!("Failed to create Skills backup directory: {e}"))?;
    let stamp = Utc::now().format("%Y%m%d-%H%M%S").to_string();
    let mut backup = backups_root.join(format!("{skill_name}-{stamp}"));
    let mut counter = 1usize;
    while backup.exists() {
        backup = backups_root.join(format!("{skill_name}-{stamp}-{counter}"));
        counter += 1;
    }
    fs::rename(target, &backup).map_err(|e| {
        format!(
            "Failed to move existing Skill to backup {}: {e}",
            backup.display()
        )
    })?;
    Ok(backup)
}

fn copy_dir_safely(source_dir: &Path, target: &Path) -> Result<(), String> {
    for entry in WalkDir::new(source_dir).follow_links(false).min_depth(1) {
        let entry = entry.map_err(|e| format!("Failed to inspect source Skill: {e}"))?;
        let source_path = entry.path();
        let rel = source_path
            .strip_prefix(source_dir)
            .map_err(|e| format!("Failed to compute relative Skill path: {e}"))?;
        let target_path = target.join(rel);
        let file_type = entry.file_type();
        if file_type.is_symlink() {
            return Err(format!(
                "Skill source contains a symlink, which is not supported: {}",
                source_path.display()
            ));
        }
        if file_type.is_dir() {
            fs::create_dir_all(&target_path)
                .map_err(|e| format!("Failed to create Skill directory: {e}"))?;
            continue;
        }
        if file_type.is_file() {
            let size = entry
                .metadata()
                .map_err(|e| format!("Failed to read source Skill file metadata: {e}"))?
                .len();
            if size > MAX_SKILL_FILE_BYTES {
                return Err(format!(
                    "Skill file is too large: {} ({} bytes)",
                    source_path.display(),
                    size
                ));
            }
            if let Some(parent) = target_path.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create Skill parent directory: {e}"))?;
            }
            fs::copy(source_path, &target_path).map_err(|e| {
                format!(
                    "Failed to copy Skill file {} to {}: {e}",
                    source_path.display(),
                    target_path.display()
                )
            })?;
        }
    }
    Ok(())
}

fn copy_skill_with_conflict(
    source_dir: &Path,
    dest_root: &Path,
    skill_name: &str,
    conflict: &str,
) -> Result<SystemSkillInstallResult, String> {
    let skill_name = sanitize_skill_name(skill_name)?;
    fs::create_dir_all(dest_root)
        .map_err(|e| format!("Failed to create Skills root directory: {e}"))?;
    let target = dest_root.join(&skill_name);
    let mut backup = None;

    if target.exists() {
        if source_dir.canonicalize().ok() == target.canonicalize().ok() {
            let metadata = read_skill_metadata_from_dir(&target)?;
            return Ok(SystemSkillInstallResult {
                name: skill_name,
                target: display_path(&target),
                backup: None,
                skill_file: rel_to_root_str(dest_root, &metadata.metadata_file),
            });
        }

        match conflict {
            "fail" => return Err(format!("Destination already exists: {}", target.display())),
            "overwrite" => {
                let meta = fs::symlink_metadata(&target)
                    .map_err(|e| format!("Failed to inspect destination: {e}"))?;
                if meta.is_dir() {
                    fs::remove_dir_all(&target).map_err(|e| {
                        format!("Failed to remove existing Skill {}: {e}", target.display())
                    })?;
                } else {
                    fs::remove_file(&target).map_err(|e| {
                        format!("Failed to remove existing Skill {}: {e}", target.display())
                    })?;
                }
            }
            "backup" => {
                backup = Some(backup_existing_path(dest_root, &target, &skill_name)?);
            }
            other => return Err(format!("Unsupported conflict mode: {other}")),
        }
    }

    fs::create_dir_all(&target)
        .map_err(|e| format!("Failed to create target Skill directory: {e}"))?;
    copy_dir_safely(source_dir, &target)?;
    let metadata = read_skill_metadata_from_dir(&target)?;
    if metadata.name != skill_name {
        return Err(format!(
            "Installed Skill metadata name '{}' does not match target directory '{}'",
            metadata.name, skill_name
        ));
    }

    Ok(SystemSkillInstallResult {
        name: skill_name,
        target: display_path(&target),
        backup: backup.map(|path| display_path(&path)),
        skill_file: rel_to_root_str(dest_root, &metadata.metadata_file),
    })
}

fn safe_extract_zip(zip_path: &Path, dest_dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dest_dir)
        .map_err(|e| format!("Failed to create archive extraction directory: {e}"))?;
    let file = fs::File::open(zip_path)
        .map_err(|e| format!("Failed to open Skill archive {}: {e}", zip_path.display()))?;
    let mut archive = ZipArchive::new(file)
        .map_err(|e| format!("Failed to read Skill archive {}: {e}", zip_path.display()))?;

    if archive.len() > MAX_SKILL_INSTALL_FILES {
        return Err(format!(
            "Skill archive contains too many files: {}",
            archive.len()
        ));
    }

    let mut total_bytes = 0u64;
    for index in 0..archive.len() {
        let mut file = archive
            .by_index(index)
            .map_err(|e| format!("Failed to read archive entry: {e}"))?;
        let Some(enclosed_name) = file.enclosed_name().map(PathBuf::from) else {
            return Err(format!(
                "Archive entry escapes extraction root: {}",
                file.name()
            ));
        };
        if enclosed_name.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::Prefix(_) | Component::RootDir
            )
        }) {
            return Err(format!("Archive entry has an unsafe path: {}", file.name()));
        }
        if file
            .unix_mode()
            .map(|mode| (mode & 0o170000) == 0o120000)
            .unwrap_or(false)
        {
            return Err(format!("Archive entry is a symlink: {}", file.name()));
        }
        total_bytes = total_bytes.saturating_add(file.size());
        if total_bytes > MAX_SKILL_INSTALL_BYTES {
            return Err(format!(
                "Skill archive is too large after extraction, over {} bytes",
                MAX_SKILL_INSTALL_BYTES
            ));
        }

        let out_path = dest_dir.join(enclosed_name);
        if file.name().ends_with('/') {
            fs::create_dir_all(&out_path)
                .map_err(|e| format!("Failed to create archive directory: {e}"))?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create archive parent directory: {e}"))?;
        }
        let mut out_file = fs::File::create(&out_path)
            .map_err(|e| format!("Failed to create archive output file: {e}"))?;
        io::copy(&mut file, &mut out_file)
            .map_err(|e| format!("Failed to extract archive entry: {e}"))?;
    }
    Ok(())
}

fn write_download_to_path_with_progress<F>(
    url: &str,
    target: &Path,
    mut on_progress: F,
) -> Result<Vec<u8>, String>
where
    F: FnMut(u64, Option<u64>),
{
    let client = HttpClient::builder()
        .timeout(Duration::from_secs(30))
        .user_agent("liveagent-skill-installer")
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))?;
    let mut response = client
        .get(url)
        .send()
        .map_err(|e| format!("Failed to download Skill source: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("Skill source download failed with HTTP {status}"));
    }
    let total_bytes = response.content_length();
    if total_bytes
        .map(|value| value > MAX_SKILL_INSTALL_BYTES)
        .unwrap_or(false)
    {
        return Err(format!(
            "Downloaded Skill source is too large, over {} bytes",
            MAX_SKILL_INSTALL_BYTES
        ));
    }

    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create Skill download directory: {e}"))?;
    }
    let mut output = fs::File::create(target)
        .map_err(|e| format!("Failed to stage downloaded Skill source: {e}"))?;
    let mut bytes = Vec::new();
    let mut downloaded = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    on_progress(downloaded, total_bytes);

    loop {
        let read = response
            .read(&mut buffer)
            .map_err(|e| format!("Failed to read Skill source response: {e}"))?;
        if read == 0 {
            break;
        }
        downloaded = downloaded.saturating_add(read as u64);
        if downloaded > MAX_SKILL_INSTALL_BYTES {
            return Err(format!(
                "Downloaded Skill source is too large, over {} bytes",
                MAX_SKILL_INSTALL_BYTES
            ));
        }
        output
            .write_all(&buffer[..read])
            .map_err(|e| format!("Failed to write downloaded Skill source: {e}"))?;
        bytes.extend_from_slice(&buffer[..read]);
        on_progress(downloaded, total_bytes);
    }
    output
        .flush()
        .map_err(|e| format!("Failed to flush downloaded Skill source: {e}"))?;
    Ok(bytes)
}

fn write_download_to_path(url: &str, target: &Path) -> Result<Vec<u8>, String> {
    write_download_to_path_with_progress(url, target, |_, _| {})
}

fn is_github_source(value: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(value) else {
        return false;
    };
    matches!(url.scheme(), "http" | "https")
        && matches!(url.host_str(), Some("github.com" | "www.github.com"))
}

fn is_http_source(value: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(value) else {
        return false;
    };
    matches!(url.scheme(), "http" | "https")
}

fn parse_github_url(value: &str, default_ref: &str) -> Result<GithubSource, String> {
    let url = reqwest::Url::parse(value).map_err(|e| format!("Invalid GitHub URL: {e}"))?;
    if !matches!(url.host_str(), Some("github.com" | "www.github.com")) {
        return Err("Only github.com URLs are supported".to_string());
    }
    let parts = url
        .path_segments()
        .ok_or_else(|| "GitHub URL must include owner and repo".to_string())?
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    if parts.len() < 2 {
        return Err("GitHub URL must include owner and repo".to_string());
    }
    let owner = parts[0].to_string();
    let repo = parts[1].trim_end_matches(".git").to_string();
    let mut git_ref = default_ref.trim();
    if git_ref.is_empty() {
        git_ref = DEFAULT_GITHUB_REF;
    }
    let mut subpath = None;

    if parts.len() > 2 {
        let marker = parts[2];
        if marker == "tree" || marker == "blob" {
            if parts.len() < 4 {
                return Err("GitHub tree/blob URL must include a ref".to_string());
            }
            git_ref = parts[3];
            if parts.len() > 4 {
                subpath = Some(parts[4..].join("/"));
            }
        } else {
            subpath = Some(parts[2..].join("/"));
        }
    }

    Ok(GithubSource {
        owner,
        repo,
        git_ref: git_ref.to_string(),
        subpath,
    })
}

fn run_git(args: &[&str], cwd: Option<&Path>) -> Result<(), String> {
    let mut command = Command::new("git");
    crate::runtime::process::configure_child_process_group(&mut command);
    command.args(args);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let output = command
        .output()
        .map_err(|e| format!("Failed to start git: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "git command failed".to_string()
        } else {
            stderr
        });
    }
    Ok(())
}

fn prepare_github_source(
    value: &str,
    method: &str,
    default_ref: &str,
    tmp_root: &Path,
) -> Result<PathBuf, String> {
    let source = parse_github_url(value, default_ref)?;
    let mut repo_root = None;
    if method == "auto" || method == "download" {
        let archive = tmp_root.join("github-repo.zip");
        let zip_url = format!(
            "https://codeload.github.com/{}/{}/zip/{}",
            source.owner, source.repo, source.git_ref
        );
        match write_download_to_path(&zip_url, &archive).and_then(|_| {
            let extract_dir = tmp_root.join("github-download");
            safe_extract_zip(&archive, &extract_dir)?;
            let mut top_levels = fs::read_dir(&extract_dir)
                .map_err(|e| format!("Failed to inspect GitHub archive: {e}"))?
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .filter(|path| path.is_dir())
                .collect::<Vec<_>>();
            top_levels.sort();
            if top_levels.len() != 1 {
                return Err("Unexpected GitHub archive layout".to_string());
            }
            Ok(top_levels.remove(0))
        }) {
            Ok(path) => repo_root = Some(path),
            Err(error) if method == "download" => {
                return Err(format!("GitHub download failed: {error}"));
            }
            Err(_) => {}
        }
    }

    if repo_root.is_none() {
        let repo_dir = tmp_root.join("github-repo");
        let repo_url = format!("https://github.com/{}/{}.git", source.owner, source.repo);
        let repo_dir_str = repo_dir
            .to_str()
            .ok_or_else(|| "Temporary git path is not valid UTF-8".to_string())?;
        let mut clone_args = vec![
            "clone",
            "--depth",
            "1",
            "--single-branch",
            "--branch",
            source.git_ref.as_str(),
        ];
        if source.subpath.is_some() {
            clone_args.push("--filter=blob:none");
            clone_args.push("--sparse");
        }
        clone_args.push(repo_url.as_str());
        clone_args.push(repo_dir_str);
        run_git(&clone_args, None)?;
        if let Some(subpath) = source.subpath.as_deref() {
            run_git(&["sparse-checkout", "set", subpath], Some(&repo_dir))?;
            run_git(&["checkout", source.git_ref.as_str()], Some(&repo_dir))?;
        }
        repo_root = Some(repo_dir);
    }

    let repo_root = repo_root.ok_or_else(|| "Failed to prepare GitHub source".to_string())?;
    if let Some(subpath) = source.subpath {
        let selected = repo_root.join(&subpath);
        if !selected.exists() {
            return Err(format!("GitHub path not found: {subpath}"));
        }
        return Ok(selected);
    }
    Ok(repo_root)
}

fn prepare_http_source_with_progress<F>(
    value: &str,
    tmp_root: &Path,
    mut on_progress: F,
) -> Result<PathBuf, String>
where
    F: FnMut(SkillInstallProgressUpdate),
{
    let url = reqwest::Url::parse(value).map_err(|e| format!("Invalid source URL: {e}"))?;
    let lower_path = url.path().to_ascii_lowercase();
    let download_path = tmp_root.join("downloaded-skill-source");
    on_progress(SkillInstallProgressUpdate {
        phase: "downloading",
        downloaded_bytes: Some(0),
        total_bytes: None,
        message: Some("Downloading Skill archive".to_string()),
    });
    let bytes =
        write_download_to_path_with_progress(value, &download_path, |downloaded, total| {
            on_progress(SkillInstallProgressUpdate {
                phase: "downloading",
                downloaded_bytes: Some(downloaded),
                total_bytes: total,
                message: Some("Downloading Skill archive".to_string()),
            });
        })?;
    let is_zip = lower_path.ends_with(".zip")
        || lower_path.ends_with(".skill")
        || bytes.starts_with(b"PK\x03\x04");

    if is_zip {
        let extract_dir = tmp_root.join("downloaded-archive");
        on_progress(SkillInstallProgressUpdate {
            phase: "extracting",
            downloaded_bytes: None,
            total_bytes: None,
            message: Some("Extracting Skill archive".to_string()),
        });
        safe_extract_zip(&download_path, &extract_dir)?;
        return Ok(extract_dir);
    }

    if lower_path.ends_with("skill.json")
        || lower_path.ends_with("skill.md")
        || lower_path.ends_with("skill")
        || strip_utf8_bom(&String::from_utf8_lossy(&bytes))
            .trim_start()
            .starts_with("---")
        || strip_utf8_bom(&String::from_utf8_lossy(&bytes))
            .trim_start()
            .starts_with('{')
    {
        let single_dir = tmp_root.join("downloaded-single-skill");
        on_progress(SkillInstallProgressUpdate {
            phase: "validating",
            downloaded_bytes: None,
            total_bytes: None,
            message: Some("Preparing downloaded Skill file".to_string()),
        });
        fs::create_dir_all(&single_dir)
            .map_err(|e| format!("Failed to stage downloaded Skill: {e}"))?;
        let file_name = if lower_path.ends_with("skill.json")
            || strip_utf8_bom(&String::from_utf8_lossy(&bytes))
                .trim_start()
                .starts_with('{')
        {
            "skill.json"
        } else {
            "SKILL.md"
        };
        fs::write(single_dir.join(file_name), bytes)
            .map_err(|e| format!("Failed to write downloaded Skill file: {e}"))?;
        return Ok(single_dir);
    }

    Err(
        "HTTP(S) Skill sources must be .zip/.skill archives or a SKILL.md/skill.json file"
            .to_string(),
    )
}

fn prepare_local_or_archive_source(source: &str, tmp_root: &Path) -> Result<PathBuf, String> {
    let source_path = crate::runtime::platform::expand_tilde_path(source);
    if !source_path.exists() {
        return Err(format!("Source not found: {source}"));
    }
    let source_path = fs::canonicalize(&source_path).map_err(|e| {
        format!(
            "Failed to resolve source path {}: {e}",
            source_path.display()
        )
    })?;

    if source_path.is_dir() {
        return Ok(source_path);
    }

    if source_path.is_file() && is_archive_path(&source_path) {
        let extract_dir = tmp_root.join("archive");
        safe_extract_zip(&source_path, &extract_dir)?;
        return Ok(extract_dir);
    }

    if source_path.is_file() && is_skill_metadata_candidate(&source_path) {
        return source_path
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| "Source Skill file has no parent directory".to_string());
    }

    Err("Source must be a skill directory, .zip/.skill archive, GitHub URL, or HTTP(S) Skill download URL".to_string())
}

fn normalize_conflict(value: Option<&str>, default_value: &str) -> Result<String, String> {
    let raw = value.unwrap_or(default_value).trim();
    match raw {
        "backup" | "fail" | "overwrite" => Ok(raw.to_string()),
        _ => Err(format!("Unsupported conflict mode: {raw}")),
    }
}

fn normalize_method(value: Option<&str>) -> Result<String, String> {
    let raw = value.unwrap_or("auto").trim();
    match raw {
        "auto" | "download" | "git" => Ok(raw.to_string()),
        _ => Err(format!("Unsupported GitHub method: {raw}")),
    }
}

fn object_string<'a>(payload: &'a serde_json::Map<String, Value>, key: &str) -> Option<&'a str> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn object_usize(payload: &serde_json::Map<String, Value>, key: &str) -> Option<usize> {
    payload
        .get(key)
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
}

fn normalize_clawhub_limit(value: Option<usize>) -> usize {
    value
        .unwrap_or(DEFAULT_CLAWHUB_SEARCH_LIMIT)
        .clamp(1, MAX_CLAWHUB_SEARCH_LIMIT)
}

fn normalize_clawhub_sort(value: Option<&str>) -> Result<&'static str, String> {
    match value.unwrap_or("downloads") {
        "downloads" => Ok("downloads"),
        "stars" => Ok("stars"),
        "installs" => Ok("installs"),
        "updated" => Ok("updated"),
        "newest" => Ok("newest"),
        other => Err(format!("Unsupported ClawHub sort: {other}")),
    }
}

fn json_object(value: &Value) -> Option<&serde_json::Map<String, Value>> {
    value.as_object()
}

fn json_string(item: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
    item.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn json_u64(item: &serde_json::Map<String, Value>, key: &str) -> u64 {
    match item.get(key) {
        Some(Value::Number(number)) => number
            .as_u64()
            .or_else(|| number.as_i64().and_then(|value| u64::try_from(value).ok()))
            .or_else(|| {
                number.as_f64().and_then(|value| {
                    if value.is_finite() && value >= 0.0 {
                        Some(value as u64)
                    } else {
                        None
                    }
                })
            })
            .unwrap_or(0),
        _ => 0,
    }
}

fn json_optional_u64(item: &serde_json::Map<String, Value>, key: &str) -> Option<u64> {
    item.get(key).and_then(|value| match value {
        Value::Number(number) => number
            .as_u64()
            .or_else(|| number.as_i64().and_then(|value| u64::try_from(value).ok())),
        _ => None,
    })
}

fn clawhub_download_url_for_slug(slug: &str, tag: Option<&str>) -> Result<String, String> {
    let slug = slug.trim();
    if slug.is_empty() {
        return Err("SkillsManager clawhub_install requires slug".to_string());
    }
    let tag = tag
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("latest");
    let mut url = reqwest::Url::parse(CLAWHUB_API_BASE)
        .and_then(|base| base.join("/api/v1/download"))
        .map_err(|e| format!("Failed to build ClawHub download URL: {e}"))?;
    url.query_pairs_mut()
        .append_pair("slug", slug)
        .append_pair("tag", tag);
    Ok(url.into())
}

fn normalize_clawhub_skill_card(raw: &Value) -> Option<SystemClawHubSkillCard> {
    let item = json_object(raw)?;
    let slug = json_string(item, "slug")?;
    let stats = item.get("stats").and_then(json_object);
    let latest_version = item
        .get("latestVersion")
        .and_then(json_object)
        .and_then(|value| json_string(value, "version"))
        .or_else(|| {
            item.get("tags")
                .and_then(json_object)
                .and_then(|value| json_string(value, "latest"))
        })
        .or_else(|| json_string(item, "version"));
    let owner_handle = json_string(item, "ownerHandle").or_else(|| {
        item.get("owner")
            .and_then(json_object)
            .and_then(|value| json_string(value, "handle"))
    });
    let download_url = clawhub_download_url_for_slug(&slug, None).ok()?;
    let web_url = owner_handle
        .as_ref()
        .map(|owner| format!("{CLAWHUB_API_BASE}/{owner}/{slug}"));

    Some(SystemClawHubSkillCard {
        slug: slug.clone(),
        display_name: json_string(item, "displayName").unwrap_or(slug),
        summary: json_string(item, "summary").unwrap_or_default(),
        latest_version,
        downloads: stats.map(|value| json_u64(value, "downloads")).unwrap_or(0),
        stars: stats.map(|value| json_u64(value, "stars")).unwrap_or(0),
        installs_current: stats
            .map(|value| json_u64(value, "installsCurrent"))
            .unwrap_or(0),
        updated_at: json_optional_u64(item, "updatedAt"),
        owner_handle,
        web_url,
        download_url,
    })
}

fn fetch_clawhub_json(path: &str, params: &[(&str, String)]) -> Result<Value, String> {
    let mut url = reqwest::Url::parse(CLAWHUB_API_BASE)
        .and_then(|base| base.join(path))
        .map_err(|e| format!("Failed to build ClawHub request URL: {e}"))?;
    {
        let mut pairs = url.query_pairs_mut();
        for (key, value) in params {
            pairs.append_pair(key, value);
        }
    }

    let client = HttpClient::builder()
        .timeout(Duration::from_secs(30))
        .user_agent("liveagent-skillsmanager")
        .build()
        .map_err(|e| format!("Failed to create ClawHub HTTP client: {e}"))?;
    let response = client
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .map_err(|e| format!("Failed to request ClawHub Skills: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("ClawHub request failed with HTTP {status}"));
    }
    response
        .json::<Value>()
        .map_err(|e| format!("Failed to parse ClawHub response: {e}"))
}

fn clawhub_results_from_field(json: &Value, key: &str) -> Vec<SystemClawHubSkillCard> {
    json.get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(normalize_clawhub_skill_card)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn search_clawhub_skills_from_payload(
    payload: &serde_json::Map<String, Value>,
) -> Result<(Vec<SystemClawHubSkillCard>, Option<String>), String> {
    let limit = normalize_clawhub_limit(object_usize(payload, "limit"));
    if let Some(query) = object_string(payload, "query") {
        let json = fetch_clawhub_json(
            "/api/v1/search",
            &[
                ("q", query.to_string()),
                ("limit", limit.to_string()),
                ("nonSuspiciousOnly", "true".to_string()),
            ],
        )?;
        return Ok((clawhub_results_from_field(&json, "results"), None));
    }

    let sort = normalize_clawhub_sort(object_string(payload, "sort"))?;
    let mut params = vec![
        ("limit", limit.to_string()),
        ("sort", sort.to_string()),
        ("nonSuspiciousOnly", "true".to_string()),
    ];
    if let Some(cursor) = object_string(payload, "cursor") {
        params.push(("cursor", cursor.to_string()));
    }
    let json = fetch_clawhub_json("/api/v1/skills", &params)?;
    let next_cursor = json
        .get("nextCursor")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    Ok((clawhub_results_from_field(&json, "items"), next_cursor))
}

fn action_from_payload(payload: &serde_json::Map<String, Value>) -> Result<String, String> {
    let action = object_string(payload, "action").unwrap_or_else(|| {
        if object_string(payload, "path").is_some() {
            "read"
        } else {
            "list"
        }
    });
    match action {
        "read" | "list" | "install" | "install_start" | "install_status" | "create"
        | "validate" | "package" | "delete" | "clawhub_search" | "clawhub_install" => {
            Ok(action.to_string())
        }
        _ => Err(format!("SkillsManager action is not supported: {action}")),
    }
}

fn install_source_from_payload(
    root: &Path,
    payload: &serde_json::Map<String, Value>,
) -> Result<Vec<SystemSkillInstallResult>, String> {
    install_source_from_payload_with_progress(root, payload, |_| {})
}

fn install_clawhub_skill_from_payload(
    root: &Path,
    payload: &serde_json::Map<String, Value>,
) -> Result<(Vec<SystemSkillInstallResult>, String, String), String> {
    let slug = object_string(payload, "slug")
        .ok_or_else(|| "SkillsManager clawhub_install requires slug".to_string())?
        .to_string();
    let version = object_string(payload, "version");
    let download_url = clawhub_download_url_for_slug(&slug, version)?;
    let mut install_payload = payload.clone();
    install_payload.insert("action".to_string(), Value::String("install".to_string()));
    install_payload.insert("source".to_string(), Value::String(download_url.clone()));
    install_payload.insert("slug".to_string(), Value::String(slug.clone()));

    let installed = install_source_from_payload(root, &install_payload)?;
    Ok((installed, slug, download_url))
}

fn install_source_from_payload_with_progress<F>(
    root: &Path,
    payload: &serde_json::Map<String, Value>,
    mut on_progress: F,
) -> Result<Vec<SystemSkillInstallResult>, String>
where
    F: FnMut(SkillInstallProgressUpdate),
{
    let source = object_string(payload, "source")
        .ok_or_else(|| "SkillsManager install requires source".to_string())?;
    let conflict = normalize_conflict(object_string(payload, "conflict"), "backup")?;
    let method = normalize_method(object_string(payload, "method"))?;
    let git_ref = object_string(payload, "ref").unwrap_or(DEFAULT_GITHUB_REF);
    let name_override = object_string(payload, "name")
        .map(sanitize_skill_name)
        .transpose()?;

    let tmp = TempDir::new("liveagent-skill-install")?;
    let stage_root = if is_github_source(source) {
        on_progress(SkillInstallProgressUpdate {
            phase: "downloading",
            downloaded_bytes: None,
            total_bytes: None,
            message: Some("Preparing GitHub Skill source".to_string()),
        });
        prepare_github_source(source, &method, git_ref, tmp.path())?
    } else if is_http_source(source) {
        prepare_http_source_with_progress(source, tmp.path(), |update| on_progress(update))?
    } else {
        on_progress(SkillInstallProgressUpdate {
            phase: "validating",
            downloaded_bytes: None,
            total_bytes: None,
            message: Some("Preparing local Skill source".to_string()),
        });
        prepare_local_or_archive_source(source, tmp.path())?
    };

    on_progress(SkillInstallProgressUpdate {
        phase: "validating",
        downloaded_bytes: None,
        total_bytes: None,
        message: Some("Validating Skill metadata".to_string()),
    });
    let candidates = discover_skill_dirs(&stage_root);
    if candidates.is_empty() {
        return Err(
            "No skill directories found. Expected SKILL.md, skill.md, skill.json, or README.md."
                .to_string(),
        );
    }
    if name_override.is_some() && candidates.len() != 1 {
        return Err("name can only be used when exactly one skill is installed".to_string());
    }

    let mut results = Vec::new();
    for candidate in candidates {
        let metadata = read_skill_metadata_from_dir(&candidate)?;
        let skill_name = name_override.as_deref().unwrap_or(&metadata.name);
        ensure_not_builtin_skill_management_target(skill_name, "install")?;
        on_progress(SkillInstallProgressUpdate {
            phase: "installing",
            downloaded_bytes: None,
            total_bytes: None,
            message: Some(format!("Installing Skill {skill_name}")),
        });
        let result = copy_skill_with_conflict(&candidate, root, skill_name, &conflict)?;
        results.push(result);
    }
    write_skill_source_metadata_for_install(root, payload, &results)?;
    Ok(results)
}

fn start_install_job_from_payload(
    root: PathBuf,
    payload: &serde_json::Map<String, Value>,
) -> Result<SystemSkillInstallJobSnapshot, String> {
    let source = object_string(payload, "source")
        .ok_or_else(|| "SkillsManager install_start requires source".to_string())?
        .to_string();
    let label = object_string(payload, "label").map(ToOwned::to_owned);
    let slug = object_string(payload, "slug").map(ToOwned::to_owned);
    let version = object_string(payload, "version").map(ToOwned::to_owned);
    normalize_conflict(object_string(payload, "conflict"), "backup")?;
    normalize_method(object_string(payload, "method"))?;

    let job_id = Uuid::new_v4().to_string();
    let now = now_millis();
    let snapshot = insert_install_job(SkillInstallJobState {
        job_id: job_id.clone(),
        phase: "queued".to_string(),
        source,
        label,
        slug,
        version,
        downloaded_bytes: 0,
        total_bytes: None,
        message: Some("Queued Skill install".to_string()),
        error: None,
        installed: None,
        started_at: now,
        updated_at: now,
        finished_at: None,
    })?;

    let thread_job_id = job_id.clone();
    let payload = payload.clone();
    thread::spawn(move || {
        let progress_job_id = thread_job_id.clone();
        let result = install_source_from_payload_with_progress(&root, &payload, move |update| {
            let _ = update_install_job(&progress_job_id, |job| {
                job.phase = update.phase.to_string();
                if update.phase == "downloading" {
                    job.total_bytes = update.total_bytes;
                }
                if let Some(downloaded_bytes) = update.downloaded_bytes {
                    job.downloaded_bytes = downloaded_bytes;
                }
                if let Some(message) = update.message {
                    job.message = Some(message);
                }
                job.error = None;
            });
        });

        match result {
            Ok(installed) => {
                let _ = update_install_job(&thread_job_id, |job| {
                    job.phase = "done".to_string();
                    job.message = Some("Skill installed".to_string());
                    job.error = None;
                    job.installed = Some(installed);
                    job.finished_at = Some(now_millis());
                });
            }
            Err(error) => {
                let _ = update_install_job(&thread_job_id, |job| {
                    job.phase = "error".to_string();
                    job.message = Some("Skill install failed".to_string());
                    job.error = Some(error);
                    job.finished_at = Some(now_millis());
                });
            }
        }
    });

    Ok(snapshot)
}

fn create_skill_from_payload(
    root: &Path,
    payload: &serde_json::Map<String, Value>,
) -> Result<SystemSkillInstallResult, String> {
    let raw_name = object_string(payload, "name")
        .ok_or_else(|| "SkillsManager create requires name".to_string())?;
    let normalized = normalize_skill_name(raw_name);
    let name = sanitize_skill_name(&normalized)?;
    ensure_not_builtin_skill_management_target(&name, "create")?;
    let description = object_string(payload, "description")
        .ok_or_else(|| "SkillsManager create requires description".to_string())?
        .trim()
        .to_string();
    if description.len() > MAX_SKILL_DESCRIPTION_LENGTH {
        return Err(format!(
            "Skill description is too long; maximum is {MAX_SKILL_DESCRIPTION_LENGTH}"
        ));
    }
    let body = object_string(payload, "body");
    let conflict = normalize_conflict(object_string(payload, "conflict"), "fail")?;

    let tmp = TempDir::new("liveagent-skill-create")?;
    let source_dir = tmp.path().join(&name);
    fs::create_dir_all(&source_dir)
        .map_err(|e| format!("Failed to create staged Skill directory: {e}"))?;
    fs::write(
        source_dir.join("SKILL.md"),
        render_skill_template(&name, &description, body),
    )
    .map_err(|e| format!("Failed to write staged SKILL.md: {e}"))?;

    if let Some(files) = payload.get("files") {
        let files = files
            .as_array()
            .ok_or_else(|| "SkillsManager create files must be an array".to_string())?;
        for file in files {
            let file = file
                .as_object()
                .ok_or_else(|| "SkillsManager create file entries must be objects".to_string())?;
            let rel = object_string(file, "path")
                .ok_or_else(|| "SkillsManager create file.path is required".to_string())?;
            let rel_path = sanitize_skill_child_rel_path(rel)?;
            if is_skill_metadata_candidate(&rel_path) {
                return Err("Use name/description/body to create SKILL.md; files must not replace Skill metadata".to_string());
            }
            let content = file
                .get("content")
                .and_then(Value::as_str)
                .ok_or_else(|| "SkillsManager create file.content is required".to_string())?;
            if content.len() as u64 > MAX_SKILL_FILE_BYTES {
                return Err(format!("Skill file is too large: {rel}"));
            }
            let target = source_dir.join(rel_path);
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create staged Skill file parent: {e}"))?;
            }
            fs::write(&target, content).map_err(|e| {
                format!(
                    "Failed to write staged Skill file {}: {e}",
                    target.display()
                )
            })?;
        }
    }

    let validation = validate_skill_dir(&source_dir);
    if !validation.ok {
        return Err(format!(
            "Created Skill did not validate:\n{}",
            validation.errors.join("\n")
        ));
    }

    copy_skill_with_conflict(&source_dir, root, &name, &conflict)
}

fn frontmatter_keys(yaml: &str) -> Vec<String> {
    if !yaml.contains('\n') {
        return [
            "name",
            "description",
            "license",
            "allowed-tools",
            "metadata",
        ]
        .into_iter()
        .filter(|key| inline_yaml_key_start(yaml, key).is_some())
        .map(ToString::to_string)
        .collect();
    }

    let mut keys = Vec::new();
    for line in yaml.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if line
            .chars()
            .next()
            .map(char::is_whitespace)
            .unwrap_or(false)
        {
            continue;
        }
        if let Some((key, _)) = line.split_once(':') {
            let key = key.trim();
            if !key.is_empty()
                && key
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
            {
                keys.push(key.to_string());
            }
        }
    }
    keys
}

fn split_frontmatter(content: &str) -> Result<(String, String), String> {
    let normalized = strip_utf8_bom(content);
    if let Some((yaml, body)) = split_inline_frontmatter(normalized) {
        return Ok((yaml, body));
    }

    let lines = normalized.split_inclusive('\n').collect::<Vec<_>>();
    let mut index = 0usize;
    while index < lines.len() && lines[index].trim().is_empty() {
        index += 1;
    }
    if index >= lines.len() || lines[index].trim() != "---" {
        return Err("Skill frontmatter must start with ---".to_string());
    }
    index += 1;
    let mut yaml = String::new();
    while index < lines.len() {
        if lines[index].trim() == "---" {
            let body = lines[index + 1..].join("");
            return Ok((yaml, body));
        }
        yaml.push_str(lines[index]);
        index += 1;
    }
    Err("Skill frontmatter is missing the closing ---".to_string())
}

fn validate_skill_dir(skill_dir: &Path) -> SkillValidationResult {
    let mut errors = Vec::new();
    if !skill_dir.exists() {
        return SkillValidationResult {
            ok: false,
            errors: vec![format!(
                "Skill directory not found: {}",
                skill_dir.display()
            )],
            metadata: None,
        };
    }
    if !skill_dir.is_dir() {
        return SkillValidationResult {
            ok: false,
            errors: vec![format!("Path is not a directory: {}", skill_dir.display())],
            metadata: None,
        };
    }

    let skill_md = skill_dir.join("SKILL.md");
    let metadata_file = if skill_md.is_file() {
        skill_md
    } else {
        match metadata_file_for(skill_dir) {
            Some(path) => path,
            None => {
                return SkillValidationResult {
                    ok: false,
                    errors: vec![
                        "SKILL.md, skill.md, skill.json, or README.md not found".to_string()
                    ],
                    metadata: None,
                };
            }
        }
    };

    let mut metadata = None;
    let mut metadata_from_plain_readme = false;
    if is_skill_json(&metadata_file) {
        match fs::read_to_string(&metadata_file)
            .map_err(|e| e.to_string())
            .and_then(|content| {
                let parsed = parse_skill_json_metadata(&content);
                let name = parsed
                    .name
                    .ok_or_else(|| "Missing 'name' in skill.json".to_string())?;
                let description = parsed
                    .description
                    .ok_or_else(|| "Missing 'description' in skill.json".to_string())?;
                Ok(SkillMetadata {
                    name,
                    description,
                    metadata_file: metadata_file.clone(),
                })
            }) {
            Ok(value) => metadata = Some(value),
            Err(error) => errors.push(error),
        }
    } else {
        match fs::read_to_string(&metadata_file)
            .map_err(|e| format!("Failed to read {}: {e}", metadata_file.display()))
            .and_then(|content| {
                let frontmatter = split_frontmatter(&content);
                let (yaml, has_frontmatter) = match frontmatter {
                    Ok((yaml, _body)) => (Some(yaml), true),
                    Err(error)
                        if is_readme_markdown(&metadata_file)
                            && is_missing_frontmatter_error(&error) =>
                    {
                        (None, false)
                    }
                    Err(error) => return Err(error),
                };

                if let Some(yaml) = yaml {
                    let keys = frontmatter_keys(&yaml);
                    let allowed = [
                        "name",
                        "description",
                        "license",
                        "allowed-tools",
                        "metadata",
                    ];
                    let unexpected = keys
                        .iter()
                        .filter(|key| !allowed.contains(&key.as_str()))
                        .cloned()
                        .collect::<Vec<_>>();
                    if !unexpected.is_empty() {
                        errors.push(format!(
                            "Unexpected key(s) in Skill frontmatter: {}",
                            unexpected.join(", ")
                        ));
                    }
                    let parsed = parse_skill_frontmatter_yaml_metadata(&yaml);
                    if is_readme_markdown(&metadata_file)
                        && parsed.name.is_none()
                        && parsed.description.is_none()
                    {
                        metadata_from_plain_readme = true;
                        let name = fallback_readme_skill_name(skill_dir)?;
                        let description = first_readme_description_line(&content)
                            .unwrap_or_else(|| format!("README.md skill instructions for {name}"))
                            .chars()
                            .take(MAX_SKILL_DESCRIPTION_LENGTH)
                            .collect();
                        return Ok(SkillMetadata {
                            name,
                            description,
                            metadata_file: metadata_file.clone(),
                        });
                    }
                    let name = parsed
                        .name
                        .ok_or_else(|| "Missing 'name' in frontmatter".to_string())?;
                    let description = parsed
                        .description
                        .ok_or_else(|| "Missing 'description' in frontmatter".to_string())?;
                    return Ok(SkillMetadata {
                        name,
                        description,
                        metadata_file: metadata_file.clone(),
                    });
                }

                if !has_frontmatter && is_readme_markdown(&metadata_file) {
                    metadata_from_plain_readme = true;
                    let name = fallback_readme_skill_name(skill_dir)?;
                    let description = first_readme_description_line(&content)
                        .unwrap_or_else(|| format!("README.md skill instructions for {name}"))
                        .chars()
                        .take(MAX_SKILL_DESCRIPTION_LENGTH)
                        .collect();
                    return Ok(SkillMetadata {
                        name,
                        description,
                        metadata_file: metadata_file.clone(),
                    });
                }

                Err("Missing Skill metadata".to_string())
            }) {
            Ok(value) => metadata = Some(value),
            Err(error) => errors.push(error),
        }
    }

    if let Some(metadata) = metadata.as_ref() {
        if let Err(error) = sanitize_skill_name(&metadata.name) {
            errors.push(error);
        }
        if metadata.description.contains('<') || metadata.description.contains('>') {
            errors.push("Description cannot contain angle brackets (< or >)".to_string());
        }
        if let Some(ch) = first_non_english_script_char(&metadata.description) {
            errors.push(format!(
                "Description must be written in English only; found non-English script character U+{:04X}",
                ch as u32
            ));
        }
        if metadata.description.len() > MAX_SKILL_DESCRIPTION_LENGTH {
            errors.push(format!(
                "Description is too long; maximum is {MAX_SKILL_DESCRIPTION_LENGTH}"
            ));
        }
        let dir_name = skill_dir
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default();
        if !metadata_from_plain_readme && dir_name != metadata.name {
            errors.push(format!(
                "Directory name '{dir_name}' must match frontmatter name '{}'",
                metadata.name
            ));
        }
    }

    for entry in WalkDir::new(skill_dir).follow_links(false).min_depth(1) {
        let Ok(entry) = entry else {
            continue;
        };
        if entry.file_type().is_symlink() {
            errors.push(format!(
                "Symlink is not allowed inside a Skill: {}",
                entry.path().display()
            ));
            continue;
        }
        if !entry.file_type().is_file() {
            continue;
        }
        let rel = entry.path().strip_prefix(skill_dir).unwrap_or(entry.path());
        if matches!(
            entry.file_name().to_string_lossy().as_ref(),
            "README.md" | "INSTALLATION_GUIDE.md" | "QUICK_REFERENCE.md" | "CHANGELOG.md"
        ) && entry.path() != metadata_file
        {
            errors.push(format!(
                "Forbidden documentation file found: {}",
                rel.to_string_lossy()
            ));
        }
        if is_markdown_document(rel) {
            validate_english_markdown_document(entry.path(), rel, &mut errors);
        }
        let ext = entry
            .path()
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.to_ascii_lowercase());
        if matches!(ext.as_deref(), Some("py" | "sh" | "bash")) {
            match fs::File::open(entry.path()) {
                Ok(file) => {
                    let mut reader = BufReader::new(file);
                    let mut line = String::new();
                    if reader.read_line(&mut line).is_ok() && !line.starts_with("#!") {
                        errors.push(format!(
                            "Script file lacks a shebang: {}",
                            rel.to_string_lossy()
                        ));
                    }
                }
                Err(error) => errors.push(format!(
                    "Failed to inspect script file {}: {error}",
                    rel.to_string_lossy()
                )),
            }
        }
    }

    SkillValidationResult {
        ok: errors.is_empty(),
        errors,
        metadata,
    }
}

fn validate_installed_skill(
    root: &Path,
    name: &str,
) -> Result<SystemSkillValidationResponse, String> {
    let name = sanitize_skill_name(name)?;
    let target = root.join(&name);
    let validation = validate_skill_dir(&target);
    Ok(SystemSkillValidationResponse {
        name,
        target: display_path(&target),
        ok: validation.ok,
        errors: validation.errors,
    })
}

fn delete_installed_skill(root: &Path, name: &str) -> Result<SystemSkillDeleteResponse, String> {
    let name = sanitize_skill_name(name)?;
    ensure_not_builtin_skill_management_target(&name, "delete")?;
    let target = root.join(&name);
    let metadata = fs::symlink_metadata(&target).map_err(|e| {
        format!(
            "Skill does not exist or cannot be inspected: {}: {e}",
            target.display()
        )
    })?;
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "SkillsManager action=delete refuses to delete symlink target: {}",
            target.display()
        ));
    }
    if !metadata.is_dir() {
        return Err(format!(
            "SkillsManager action=delete requires an installed Skill directory: {}",
            target.display()
        ));
    }
    fs::remove_dir_all(&target)
        .map_err(|e| format!("Failed to delete Skill {}: {e}", target.display()))?;
    Ok(SystemSkillDeleteResponse {
        name,
        target: display_path(&target),
    })
}

fn package_installed_skill(root: &Path, name: &str) -> Result<SystemSkillPackageResponse, String> {
    let name = sanitize_skill_name(name)?;
    let target = root.join(&name);
    let validation = validate_skill_dir(&target);
    if !validation.ok {
        return Err(format!(
            "Validation failed before packaging:\n{}",
            validation.errors.join("\n")
        ));
    }
    let packages_root = root.join(".packages");
    fs::create_dir_all(&packages_root)
        .map_err(|e| format!("Failed to create Skills packages directory: {e}"))?;
    let archive = packages_root.join(format!("{name}.skill"));
    let archive_file = fs::File::create(&archive)
        .map_err(|e| format!("Failed to create Skill archive {}: {e}", archive.display()))?;
    let mut writer = ZipWriter::new(archive_file);
    let options = FileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o644);

    for entry in WalkDir::new(&target).follow_links(false).min_depth(1) {
        let entry = entry.map_err(|e| format!("Failed to inspect Skill for packaging: {e}"))?;
        if entry.file_type().is_symlink() {
            return Err(format!(
                "Cannot package symlink inside Skill: {}",
                entry.path().display()
            ));
        }
        if !entry.file_type().is_file() {
            continue;
        }
        let rel = entry
            .path()
            .strip_prefix(root)
            .map_err(|e| format!("Failed to compute archive path: {e}"))?
            .to_string_lossy()
            .replace('\\', "/");
        writer
            .start_file(rel, options)
            .map_err(|e| format!("Failed to start archive file: {e}"))?;
        let mut file = fs::File::open(entry.path())
            .map_err(|e| format!("Failed to open Skill file for packaging: {e}"))?;
        io::copy(&mut file, &mut writer)
            .map_err(|e| format!("Failed to write Skill archive: {e}"))?;
    }
    writer
        .finish()
        .map_err(|e| format!("Failed to finish Skill archive: {e}"))?;

    Ok(SystemSkillPackageResponse {
        name,
        target: display_path(&target),
        archive: display_path(&archive),
    })
}

pub fn ensure_builtin_agent_skills_sync() -> Result<Vec<SystemBuiltinSkillSeedResponse>, String> {
    let root = skills_root_dir()?;
    ensure_builtin_agent_skills_in_root(&root)
}

fn builtin_skill_files_match(target: &Path, builtin: &BuiltinSkill) -> Result<bool, String> {
    let mut actual_files = Vec::new();
    for entry in WalkDir::new(target).follow_links(false).min_depth(1) {
        let entry = entry.map_err(|e| format!("Failed to inspect built-in Skill: {e}"))?;
        if !entry.file_type().is_file() {
            continue;
        }
        let rel = entry
            .path()
            .strip_prefix(target)
            .map_err(|e| format!("Failed to compute built-in Skill path: {e}"))?
            .to_string_lossy()
            .replace('\\', "/");
        actual_files.push(rel);
    }
    actual_files.sort();

    let mut expected_files = builtin
        .files
        .iter()
        .map(|file| {
            sanitize_skill_child_rel_path(file.path)
                .map(|path| path.to_string_lossy().replace('\\', "/"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    expected_files.sort();
    if actual_files != expected_files {
        return Ok(false);
    }

    for file in builtin.files {
        let rel = sanitize_skill_child_rel_path(file.path)?;
        let path = target.join(rel);
        match fs::read_to_string(&path) {
            Ok(content) if content == file.content => {}
            Ok(_) => return Ok(false),
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(error) => {
                return Err(format!(
                    "Failed to read built-in Skill file {}: {error}",
                    path.display()
                ));
            }
        }
    }
    Ok(true)
}

fn ensure_builtin_agent_skills_in_root(
    root: &Path,
) -> Result<Vec<SystemBuiltinSkillSeedResponse>, String> {
    fs::create_dir_all(root).map_err(|e| format!("Failed to create Skills root directory: {e}"))?;
    let mut results = Vec::new();
    for builtin in BUILTIN_AGENT_SKILLS {
        let name = sanitize_skill_name(builtin.name)?;
        let target = root.join(&name);
        let mut backup = None;
        let mut write_action = "created";

        if target.exists() {
            let validation = validate_skill_dir(&target);
            let valid_same_name = validation.ok
                && validation
                    .metadata
                    .as_ref()
                    .map(|metadata| metadata.name == name)
                    .unwrap_or(false);
            if valid_same_name {
                if builtin_skill_files_match(&target, builtin)? {
                    results.push(SystemBuiltinSkillSeedResponse {
                        name,
                        target: display_path(&target),
                        action: "kept".to_string(),
                        backup: None,
                    });
                    continue;
                }
                write_action = "updated";
            } else {
                write_action = "replaced_invalid";
            }
            backup = Some(backup_existing_path(&root, &target, &name)?);
        }

        fs::create_dir_all(&target)
            .map_err(|e| format!("Failed to create built-in Skill directory: {e}"))?;
        for file in builtin.files {
            let rel = sanitize_skill_child_rel_path(file.path)?;
            let path = target.join(rel);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create built-in Skill parent: {e}"))?;
            }
            fs::write(&path, file.content).map_err(|e| {
                format!(
                    "Failed to write built-in Skill file {}: {e}",
                    path.display()
                )
            })?;
        }
        let validation = validate_skill_dir(&target);
        if !validation.ok {
            return Err(format!(
                "Built-in Skill '{}' did not validate after seeding:\n{}",
                builtin.name,
                validation.errors.join("\n")
            ));
        }
        results.push(SystemBuiltinSkillSeedResponse {
            name,
            target: display_path(&target),
            action: write_action.to_string(),
            backup: backup.map(|path| display_path(&path)),
        });
    }
    Ok(results)
}

pub fn system_manage_skill_sync(payload: Value) -> Result<SystemManageSkillResponse, String> {
    let root = skills_root_dir()?;
    let root_dir = skill_root_display(&root);
    let payload = payload
        .as_object()
        .ok_or_else(|| "SkillsManager payload must be an object".to_string())?;
    let action = action_from_payload(payload)?;

    match action.as_str() {
        "read" => {
            let path = object_string(payload, "path")
                .ok_or_else(|| "SkillsManager read requires path".to_string())?;
            let offset = object_usize(payload, "offset");
            let length = object_usize(payload, "length");
            let result = read_skill_text_from_root(&root, path, offset, length)?;
            let num_lines = result.content.match_indices('\n').count()
                + usize::from(!result.content.is_empty() && !result.content.ends_with('\n'));
            Ok(SystemManageSkillResponse {
                action,
                root_dir,
                path: Some(path.to_string()),
                content: Some(result.content),
                truncated: Some(result.truncated),
                start_line: Some(offset.unwrap_or(0) + 1),
                num_lines: Some(num_lines),
                skills: None,
                invalid: None,
                installed: None,
                created: None,
                validation: None,
                package: None,
                deleted: None,
                seeded: None,
                install_job: None,
                clawhub_results: None,
                clawhub_next_cursor: None,
                clawhub_slug: None,
                clawhub_download_url: None,
            })
        }
        "list" => {
            let (skills, invalid) = list_installed_skills(&root)?;
            Ok(SystemManageSkillResponse {
                action,
                root_dir,
                path: None,
                content: None,
                truncated: None,
                start_line: None,
                num_lines: None,
                skills: Some(skills),
                invalid: Some(invalid),
                installed: None,
                created: None,
                validation: None,
                package: None,
                deleted: None,
                seeded: None,
                install_job: None,
                clawhub_results: None,
                clawhub_next_cursor: None,
                clawhub_slug: None,
                clawhub_download_url: None,
            })
        }
        "clawhub_search" => {
            let (clawhub_results, clawhub_next_cursor) =
                search_clawhub_skills_from_payload(payload)?;
            Ok(SystemManageSkillResponse {
                action,
                root_dir,
                path: None,
                content: None,
                truncated: None,
                start_line: None,
                num_lines: None,
                skills: None,
                invalid: None,
                installed: None,
                created: None,
                validation: None,
                package: None,
                deleted: None,
                seeded: None,
                install_job: None,
                clawhub_results: Some(clawhub_results),
                clawhub_next_cursor,
                clawhub_slug: None,
                clawhub_download_url: None,
            })
        }
        "install" => {
            let installed = install_source_from_payload(&root, payload)?;
            Ok(SystemManageSkillResponse {
                action,
                root_dir,
                path: None,
                content: None,
                truncated: None,
                start_line: None,
                num_lines: None,
                skills: None,
                invalid: None,
                installed: Some(installed),
                created: None,
                validation: None,
                package: None,
                deleted: None,
                seeded: None,
                install_job: None,
                clawhub_results: None,
                clawhub_next_cursor: None,
                clawhub_slug: None,
                clawhub_download_url: None,
            })
        }
        "clawhub_install" => {
            let (installed, slug, download_url) =
                install_clawhub_skill_from_payload(&root, payload)?;
            Ok(SystemManageSkillResponse {
                action,
                root_dir,
                path: None,
                content: None,
                truncated: None,
                start_line: None,
                num_lines: None,
                skills: None,
                invalid: None,
                installed: Some(installed),
                created: None,
                validation: None,
                package: None,
                deleted: None,
                seeded: None,
                install_job: None,
                clawhub_results: None,
                clawhub_next_cursor: None,
                clawhub_slug: Some(slug),
                clawhub_download_url: Some(download_url),
            })
        }
        "install_start" => {
            let install_job = start_install_job_from_payload(root.clone(), payload)?;
            Ok(SystemManageSkillResponse {
                action,
                root_dir,
                path: None,
                content: None,
                truncated: None,
                start_line: None,
                num_lines: None,
                skills: None,
                invalid: None,
                installed: None,
                created: None,
                validation: None,
                package: None,
                deleted: None,
                seeded: None,
                install_job: Some(install_job),
                clawhub_results: None,
                clawhub_next_cursor: None,
                clawhub_slug: None,
                clawhub_download_url: None,
            })
        }
        "install_status" => {
            let job_id = object_string(payload, "jobId")
                .or_else(|| object_string(payload, "job_id"))
                .ok_or_else(|| "SkillsManager install_status requires jobId".to_string())?;
            let install_job = get_install_job_snapshot(job_id)?;
            Ok(SystemManageSkillResponse {
                action,
                root_dir,
                path: None,
                content: None,
                truncated: None,
                start_line: None,
                num_lines: None,
                skills: None,
                invalid: None,
                installed: None,
                created: None,
                validation: None,
                package: None,
                deleted: None,
                seeded: None,
                install_job: Some(install_job),
                clawhub_results: None,
                clawhub_next_cursor: None,
                clawhub_slug: None,
                clawhub_download_url: None,
            })
        }
        "create" => {
            let created = create_skill_from_payload(&root, payload)?;
            Ok(SystemManageSkillResponse {
                action,
                root_dir,
                path: None,
                content: None,
                truncated: None,
                start_line: None,
                num_lines: None,
                skills: None,
                invalid: None,
                installed: None,
                created: Some(created),
                validation: None,
                package: None,
                deleted: None,
                seeded: None,
                install_job: None,
                clawhub_results: None,
                clawhub_next_cursor: None,
                clawhub_slug: None,
                clawhub_download_url: None,
            })
        }
        "validate" => {
            let name = object_string(payload, "name")
                .ok_or_else(|| "SkillsManager validate requires name".to_string())?;
            let validation = validate_installed_skill(&root, name)?;
            Ok(SystemManageSkillResponse {
                action,
                root_dir,
                path: None,
                content: None,
                truncated: None,
                start_line: None,
                num_lines: None,
                skills: None,
                invalid: None,
                installed: None,
                created: None,
                validation: Some(validation),
                package: None,
                deleted: None,
                seeded: None,
                install_job: None,
                clawhub_results: None,
                clawhub_next_cursor: None,
                clawhub_slug: None,
                clawhub_download_url: None,
            })
        }
        "package" => {
            let name = object_string(payload, "name")
                .ok_or_else(|| "SkillsManager package requires name".to_string())?;
            let package = package_installed_skill(&root, name)?;
            Ok(SystemManageSkillResponse {
                action,
                root_dir,
                path: None,
                content: None,
                truncated: None,
                start_line: None,
                num_lines: None,
                skills: None,
                invalid: None,
                installed: None,
                created: None,
                validation: None,
                package: Some(package),
                deleted: None,
                seeded: None,
                install_job: None,
                clawhub_results: None,
                clawhub_next_cursor: None,
                clawhub_slug: None,
                clawhub_download_url: None,
            })
        }
        "delete" => {
            let name = object_string(payload, "name")
                .ok_or_else(|| "SkillsManager delete requires name".to_string())?;
            let deleted = delete_installed_skill(&root, name)?;
            Ok(SystemManageSkillResponse {
                action,
                root_dir,
                path: None,
                content: None,
                truncated: None,
                start_line: None,
                num_lines: None,
                skills: None,
                invalid: None,
                installed: None,
                created: None,
                validation: None,
                package: None,
                deleted: Some(deleted),
                seeded: None,
                install_job: None,
                clawhub_results: None,
                clawhub_next_cursor: None,
                clawhub_slug: None,
                clawhub_download_url: None,
            })
        }
        _ => Err(format!("SkillsManager action is not supported: {action}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn write_skill(root: &Path, name: &str, description: &str) -> PathBuf {
        let dir = root.join(name);
        fs::create_dir_all(&dir).expect("create skill dir");
        fs::write(
            dir.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: {description}\n---\n\n# {name}\n"),
        )
        .expect("write skill");
        dir
    }

    #[test]
    fn skill_name_rejects_windows_reserved_names() {
        assert!(sanitize_skill_name("safe-skill").is_ok());
        assert!(sanitize_skill_name("con").is_err());
        assert!(sanitize_skill_name("aux").is_err());
        assert!(sanitize_skill_name("com9").is_err());
        assert!(sanitize_skill_name("com0").is_ok());
    }

    #[test]
    fn skill_rel_path_rejects_windows_reserved_components() {
        assert!(sanitize_skill_child_rel_path("references/notes.md").is_ok());
        assert!(sanitize_skill_child_rel_path("references/con.md").is_err());
        assert!(sanitize_skill_child_rel_path("references/LPT1.txt").is_err());
        assert!(sanitize_skill_child_rel_path("references/com0.txt").is_ok());
    }

    #[test]
    fn github_tree_url_parses_ref_and_subpath() {
        let source = parse_github_url(
            "https://github.com/owner/repo/tree/main/skills/example",
            DEFAULT_GITHUB_REF,
        )
        .expect("parse github url");

        assert_eq!(source.owner, "owner");
        assert_eq!(source.repo, "repo");
        assert_eq!(source.git_ref, "main");
        assert_eq!(source.subpath.as_deref(), Some("skills/example"));
    }

    #[test]
    fn discover_skill_dirs_supports_repo_skills_folder() {
        let tmp = TempDir::new("liveagent-skill-discover-test").expect("temp dir");
        let skills_root = tmp.path().join("repo").join("skills");
        write_skill(&skills_root, "first-skill", "First");
        write_skill(&skills_root, "second-skill", "Second");

        let dirs = discover_skill_dirs(&tmp.path().join("repo"));
        let names = dirs
            .iter()
            .map(|path| path.file_name().unwrap().to_string_lossy().to_string())
            .collect::<Vec<_>>();

        assert_eq!(names, vec!["first-skill", "second-skill"]);
    }

    #[test]
    fn discover_skill_dirs_does_not_let_root_readme_override_skills_folder() {
        let tmp = TempDir::new("liveagent-readme-root-discover-test").expect("temp dir");
        let repo = tmp.path().join("repo");
        fs::create_dir_all(&repo).expect("create repo");
        fs::write(repo.join("README.md"), "# Repo README\n").expect("write repo readme");
        write_skill(&repo.join("skills"), "nested-skill", "Nested");

        let dirs = discover_skill_dirs(&repo);
        let names = dirs
            .iter()
            .map(|path| path.file_name().unwrap().to_string_lossy().to_string())
            .collect::<Vec<_>>();

        assert_eq!(names, vec!["nested-skill"]);
    }

    #[test]
    fn readme_frontmatter_is_used_as_skill_metadata_fallback() {
        let tmp = TempDir::new("liveagent-readme-frontmatter-test").expect("temp dir");
        let dir = tmp.path().join("readme-skill");
        fs::create_dir_all(&dir).expect("create skill dir");
        fs::write(
            dir.join("README.md"),
            "---\nname: readme-skill\ndescription: README metadata\n---\n\n# README Skill\n",
        )
        .expect("write readme");

        let metadata = read_skill_metadata_from_dir(&dir).expect("read metadata");
        assert_eq!(metadata.name, "readme-skill");
        assert_eq!(metadata.description, "README metadata");
        assert_eq!(metadata.metadata_file.file_name().unwrap(), "README.md");

        let validation = validate_skill_dir(&dir);
        assert!(validation.ok, "{:?}", validation.errors);
    }

    #[test]
    fn readme_without_frontmatter_derives_metadata_for_management() {
        let tmp = TempDir::new("liveagent-plain-readme-test").expect("temp dir");
        let dir = tmp.path().join("plain-readme-skill");
        fs::create_dir_all(&dir).expect("create skill dir");
        fs::write(
            dir.join("README.md"),
            "# Plain README Skill\n\nFollow this README as the skill instructions.\n",
        )
        .expect("write readme");

        let raw_metadata =
            read_skill_metadata_file(&dir.join("README.md")).expect("read raw metadata");
        assert!(raw_metadata.name.is_none());
        assert!(raw_metadata.description.is_none());

        let metadata = read_skill_metadata_from_dir(&dir).expect("derive metadata");
        assert_eq!(metadata.name, "plain-readme-skill");
        assert_eq!(metadata.description, "Plain README Skill");

        let validation = validate_skill_dir(&dir);
        assert!(validation.ok, "{:?}", validation.errors);
    }

    #[test]
    fn readme_empty_frontmatter_derives_metadata_for_management() {
        let tmp = TempDir::new("liveagent-empty-readme-frontmatter-test").expect("temp dir");
        let dir = tmp.path().join("empty-readme-metadata");
        fs::create_dir_all(&dir).expect("create skill dir");
        fs::write(
            dir.join("README.md"),
            "---\n---\n\n# Empty README Metadata\n\nUse the README content.\n",
        )
        .expect("write readme");

        let metadata = read_skill_metadata_from_dir(&dir).expect("derive metadata");
        assert_eq!(metadata.name, "empty-readme-metadata");
        assert_eq!(metadata.description, "Empty README Metadata");

        let validation = validate_skill_dir(&dir);
        assert!(validation.ok, "{:?}", validation.errors);
    }

    #[test]
    fn readme_partial_frontmatter_is_invalid_metadata() {
        let tmp = TempDir::new("liveagent-partial-readme-frontmatter-test").expect("temp dir");
        let dir = tmp.path().join("partial-readme-metadata");
        fs::create_dir_all(&dir).expect("create skill dir");
        fs::write(
            dir.join("README.md"),
            "---\nname: partial-readme-metadata\n---\n\n# Partial README Metadata\n",
        )
        .expect("write readme");

        let error = read_skill_metadata_from_dir(&dir).expect_err("partial metadata must fail");
        assert!(
            error.contains("Missing skill description"),
            "unexpected error: {error}"
        );

        let validation = validate_skill_dir(&dir);
        assert!(!validation.ok);
        assert!(
            validation
                .errors
                .iter()
                .any(|error| error.contains("Missing 'description'")),
            "{:?}",
            validation.errors
        );
    }

    #[test]
    fn readme_inside_existing_skill_is_not_a_discovery_candidate() {
        let tmp = TempDir::new("liveagent-nested-readme-discovery-test").expect("temp dir");
        let root = tmp.path().join("skills");
        let skill_dir = write_skill(&root, "documented-skill", "Documented");
        let reference_dir = skill_dir.join("references");
        fs::create_dir_all(&reference_dir).expect("create references");
        let readme = reference_dir.join("README.md");
        fs::write(&readme, "# Reference README\n").expect("write nested readme");

        assert!(!should_include_metadata_candidate(&root, &readme));
        assert!(should_include_metadata_candidate(
            &root,
            &skill_dir.join("SKILL.md")
        ));
    }

    #[test]
    fn copy_skill_with_backup_preserves_existing_target() {
        let tmp = TempDir::new("liveagent-skill-backup-test").expect("temp dir");
        let root = tmp.path().join("skills");
        let source_a = tmp.path().join("source-a");
        let source_b = tmp.path().join("source-b");
        write_skill(&source_a, "sample-skill", "Old");
        write_skill(&source_b, "sample-skill", "New");

        let first = copy_skill_with_conflict(
            &source_a.join("sample-skill"),
            &root,
            "sample-skill",
            "fail",
        )
        .expect("first install");
        assert!(first.backup.is_none());

        let second = copy_skill_with_conflict(
            &source_b.join("sample-skill"),
            &root,
            "sample-skill",
            "backup",
        )
        .expect("second install");

        assert!(second.backup.is_some());
        assert!(root.join(".backups").exists());
    }

    #[test]
    fn builtin_seed_backs_up_invalid_target_before_writing() {
        let tmp = TempDir::new("liveagent-builtin-seed-test").expect("temp dir");
        let root = tmp.path().join("skills");
        let invalid_target = root.join("skills-installer");
        fs::create_dir_all(&invalid_target).expect("create invalid target");
        fs::write(invalid_target.join("SKILL.md"), "not valid frontmatter\n")
            .expect("write invalid skill");

        let seeded = ensure_builtin_agent_skills_in_root(&root).expect("seed builtins");
        let installer = seeded
            .iter()
            .find(|item| item.name == "skills-installer")
            .expect("installer seed result");

        assert_eq!(installer.action, "replaced_invalid");
        assert!(installer.backup.is_some());
        assert!(root.join(".backups").exists());
        let validation = validate_skill_dir(&root.join("skills-installer"));
        assert!(validation.ok, "{:?}", validation.errors);
    }

    #[test]
    fn builtin_seed_updates_changed_valid_target_before_writing() {
        let tmp = TempDir::new("liveagent-builtin-update-test").expect("temp dir");
        let root = tmp.path().join("skills");
        let old_target = root.join("skills-creator");
        fs::create_dir_all(&old_target).expect("create old target");
        fs::write(
            old_target.join("SKILL.md"),
            "---\nname: skills-creator\ndescription: Old valid creator\n---\n\n# Old Creator\n\nUse the old workflow.\n",
        )
        .expect("write old skill");

        let seeded = ensure_builtin_agent_skills_in_root(&root).expect("seed builtins");
        let creator = seeded
            .iter()
            .find(|item| item.name == "skills-creator")
            .expect("creator seed result");

        assert_eq!(creator.action, "updated");
        assert!(creator.backup.is_some());
        let content =
            fs::read_to_string(root.join("skills-creator").join("SKILL.md")).expect("read seeded");
        assert!(
            content.contains("All generated skill documentation must be written in English only")
        );
        let validation = validate_skill_dir(&root.join("skills-creator"));
        assert!(validation.ok, "{:?}", validation.errors);
    }

    #[test]
    fn builtin_seed_removes_retired_builtin_files() {
        let tmp = TempDir::new("liveagent-builtin-retired-file-test").expect("temp dir");
        let root = tmp.path().join("skills");

        ensure_builtin_agent_skills_in_root(&root).expect("seed builtins");
        let creator_dir = root.join("skills-creator");
        let retired_script = creator_dir.join("scripts").join("old_helper.py");
        fs::create_dir_all(retired_script.parent().expect("script parent"))
            .expect("create scripts");
        fs::write(&retired_script, "#!/usr/bin/env python3\nprint('old')\n")
            .expect("write retired script");

        let seeded = ensure_builtin_agent_skills_in_root(&root).expect("reseed builtins");
        let creator = seeded
            .iter()
            .find(|item| item.name == "skills-creator")
            .expect("creator seed result");

        assert_eq!(creator.action, "updated");
        assert!(creator.backup.is_some());
        assert!(!root.join("skills-creator").join("scripts").exists());
    }

    #[test]
    fn list_installed_skills_skips_hidden_backup_dirs() {
        let tmp = TempDir::new("liveagent-skill-list-test").expect("temp dir");
        let root = tmp.path().join("skills");
        write_skill(&root, "active-skill", "Active");
        write_skill(&root.join(".backups"), "backup-skill", "Backup");

        let (skills, invalid) = list_installed_skills(&root).expect("list skills");

        assert!(invalid.is_empty(), "{invalid:?}");
        assert_eq!(
            skills
                .iter()
                .map(|skill| skill.name.as_str())
                .collect::<Vec<_>>(),
            vec!["active-skill"]
        );
    }

    #[test]
    fn install_source_from_local_skill_archive_installs_skill() {
        let tmp = TempDir::new("liveagent-skill-archive-install-test").expect("temp dir");
        let root = tmp.path().join("skills");
        let archive = tmp.path().join("archive-skill.skill");
        {
            let file = fs::File::create(&archive).expect("archive file");
            let mut writer = ZipWriter::new(file);
            let options = FileOptions::default().compression_method(CompressionMethod::Deflated);
            writer
                .start_file("archive-skill/SKILL.md", options)
                .expect("start skill file");
            writer
                .write_all(
                    b"---\nname: archive-skill\ndescription: Archive install\n---\n\n# Archive Skill\n",
                )
                .expect("write skill file");
            writer.finish().expect("finish archive");
        }
        let payload = json!({
            "source": archive.to_string_lossy(),
            "conflict": "fail"
        });
        let payload = payload.as_object().expect("payload object");

        let installed = install_source_from_payload(&root, payload).expect("install archive");

        assert_eq!(installed.len(), 1);
        assert_eq!(installed[0].name, "archive-skill");
        assert!(root.join("archive-skill").join("SKILL.md").is_file());
    }

    #[test]
    fn clawhub_download_url_preserves_slug_and_tag_params() {
        let url = clawhub_download_url_for_slug("owner/example-skill", Some("v1.2.3"))
            .expect("download url");
        let parsed = reqwest::Url::parse(&url).expect("parse url");
        let pairs = parsed
            .query_pairs()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect::<HashMap<_, _>>();

        assert_eq!(parsed.scheme(), "https");
        assert_eq!(parsed.host_str(), Some("clawhub.ai"));
        assert_eq!(parsed.path(), "/api/v1/download");
        assert_eq!(
            pairs.get("slug").map(String::as_str),
            Some("owner/example-skill")
        );
        assert_eq!(pairs.get("tag").map(String::as_str), Some("v1.2.3"));
    }

    #[test]
    fn normalize_clawhub_skill_card_supports_search_shape() {
        let raw = json!({
            "slug": "owner/example-skill",
            "displayName": "Example Skill",
            "summary": "Example summary",
            "latestVersion": { "version": "1.0.0" },
            "stats": {
                "downloads": 11,
                "stars": 7,
                "installsCurrent": 3
            },
            "updatedAt": 12345,
            "owner": { "handle": "owner" }
        });

        let card = normalize_clawhub_skill_card(&raw).expect("normalize card");

        assert_eq!(card.slug, "owner/example-skill");
        assert_eq!(card.display_name, "Example Skill");
        assert_eq!(card.latest_version.as_deref(), Some("1.0.0"));
        assert_eq!(card.downloads, 11);
        assert_eq!(card.stars, 7);
        assert_eq!(card.installs_current, 3);
        assert_eq!(card.owner_handle.as_deref(), Some("owner"));
        assert!(card.download_url.contains("/api/v1/download"));
    }

    #[test]
    fn install_source_persists_clawhub_metadata_when_slug_is_present() {
        let tmp = TempDir::new("liveagent-skill-clawhub-meta-test").expect("temp dir");
        let root = tmp.path().join("skills");
        let source = tmp.path().join("source");
        write_skill(&source, "clawhub-skill", "ClawHub install");
        let payload = json!({
            "source": source.to_string_lossy(),
            "conflict": "fail",
            "slug": "owner/clawhub-skill",
            "version": "1.0.0",
            "publishedAt": 12345
        });
        let payload = payload.as_object().expect("payload object");

        let installed = install_source_from_payload(&root, payload).expect("install skill");
        let source_metadata =
            read_skill_source_metadata(&root.join(&installed[0].name)).expect("read source meta");

        assert_eq!(source_metadata.registry, "clawhub");
        assert_eq!(source_metadata.slug, "owner/clawhub-skill");
        assert_eq!(source_metadata.version.as_deref(), Some("1.0.0"));
        assert_eq!(source_metadata.published_at, Some(12345));
    }

    #[test]
    fn validate_and_package_round_trip() {
        let tmp = TempDir::new("liveagent-skill-package-test").expect("temp dir");
        let root = tmp.path().join("skills");
        write_skill(&root, "package-skill", "Package test");

        let validation =
            validate_installed_skill(&root, "package-skill").expect("validate installed skill");
        assert!(validation.ok, "{:?}", validation.errors);

        let package = package_installed_skill(&root, "package-skill").expect("package skill");
        assert!(Path::new(&package.archive).exists());
    }

    #[test]
    fn delete_installed_skill_removes_user_skill() {
        let tmp = TempDir::new("liveagent-skill-delete-test").expect("temp dir");
        let root = tmp.path().join("skills");
        let skill_dir = write_skill(&root, "delete-skill", "Delete test");

        let deleted = delete_installed_skill(&root, "delete-skill").expect("delete skill");

        assert_eq!(deleted.name, "delete-skill");
        assert_eq!(deleted.target, display_path(&skill_dir));
        assert!(!skill_dir.exists());
    }

    #[test]
    fn delete_installed_skill_rejects_builtin_skill() {
        let tmp = TempDir::new("liveagent-skill-delete-builtin-test").expect("temp dir");
        let root = tmp.path().join("skills");
        write_skill(&root, "skills-installer", "Built-in replacement");

        let error =
            delete_installed_skill(&root, "skills-installer").expect_err("delete should fail");

        assert!(
            error.contains("cannot modify built-in Skill"),
            "unexpected error: {error}"
        );
        assert!(root.join("skills-installer").exists());
    }

    #[test]
    fn delete_installed_skill_rejects_missing_skill() {
        let tmp = TempDir::new("liveagent-skill-delete-missing-test").expect("temp dir");
        let root = tmp.path().join("skills");

        let error = delete_installed_skill(&root, "missing-skill").expect_err("delete should fail");

        assert!(
            error.contains("does not exist") || error.contains("cannot be inspected"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn delete_installed_skill_rejects_non_directory_target() {
        let tmp = TempDir::new("liveagent-skill-delete-file-test").expect("temp dir");
        let root = tmp.path().join("skills");
        fs::create_dir_all(&root).expect("create skills root");
        let file = root.join("file-skill");
        fs::write(&file, "not a directory").expect("write file target");

        let error = delete_installed_skill(&root, "file-skill").expect_err("delete should fail");

        assert!(
            error.contains("requires an installed Skill directory"),
            "unexpected error: {error}"
        );
        assert!(file.exists());
    }

    #[test]
    fn validate_allows_nested_metadata_frontmatter() {
        let tmp = TempDir::new("liveagent-skill-frontmatter-test").expect("temp dir");
        let root = tmp.path().join("skills");
        let dir = root.join("metadata-skill");
        fs::create_dir_all(&dir).expect("create skill dir");
        fs::write(
            dir.join("SKILL.md"),
            "---\nname: metadata-skill\ndescription: Metadata test\nmetadata:\n  short-description: Nested metadata\n---\n\n# Metadata Skill\n",
        )
        .expect("write skill");

        let validation = validate_installed_skill(&root, "metadata-skill").expect("validate skill");

        assert!(validation.ok, "{:?}", validation.errors);
    }

    #[test]
    fn validate_allows_single_line_frontmatter() {
        let tmp = TempDir::new("liveagent-skill-inline-frontmatter-test").expect("temp dir");
        let root = tmp.path().join("skills");
        let dir = root.join("security-threat-model");
        fs::create_dir_all(&dir).expect("create skill dir");
        fs::write(
            dir.join("SKILL.md"),
            "--- name: security-threat-model description: Develop threat models and security analysis for software systems --- Use this skill when reviewing security risks.\n",
        )
        .expect("write skill");

        let metadata = read_skill_metadata_from_dir(&dir).expect("read metadata");
        assert_eq!(metadata.name, "security-threat-model");
        assert_eq!(
            metadata.description,
            "Develop threat models and security analysis for software systems"
        );

        let validation =
            validate_installed_skill(&root, "security-threat-model").expect("validate skill");
        assert!(validation.ok, "{:?}", validation.errors);
    }

    #[test]
    fn validate_rejects_non_english_markdown_documentation() {
        let tmp = TempDir::new("liveagent-skill-english-doc-test").expect("temp dir");
        let root = tmp.path().join("skills");
        let dir = root.join("english-only-skill");
        fs::create_dir_all(&dir).expect("create skill dir");
        fs::write(
            dir.join("SKILL.md"),
            "---\nname: english-only-skill\ndescription: English documentation test\n---\n\n# English Only Skill\n\nTranslate \u{4E2D} before saving the skill.\n",
        )
        .expect("write skill");

        let validation =
            validate_installed_skill(&root, "english-only-skill").expect("validate skill");

        assert!(!validation.ok);
        assert!(
            validation
                .errors
                .iter()
                .any(|error| error.contains("English only")),
            "{:?}",
            validation.errors
        );
    }

    #[test]
    fn create_skill_rejects_non_english_body() {
        let tmp = TempDir::new("liveagent-skill-create-english-test").expect("temp dir");
        let root = tmp.path().join("skills");
        let payload = json!({
            "name": "english-create-skill",
            "description": "Create only English documentation",
            "body": "# English Create Skill\n\nTranslate \u{4E2D} before writing docs.",
            "conflict": "fail"
        });
        let payload = payload.as_object().expect("payload object");

        let error = create_skill_from_payload(&root, payload).expect_err("create should fail");

        assert!(error.contains("English only"), "unexpected error: {error}");
    }

    #[test]
    fn create_skill_rejects_builtin_skill_names() {
        let tmp = TempDir::new("liveagent-skill-create-builtin-test").expect("temp dir");
        let root = tmp.path().join("skills");
        let payload = json!({
            "name": "skills-creator",
            "description": "Attempt to replace built-in creator",
            "body": "# Replacement\n\nDo not allow this.",
            "conflict": "overwrite"
        });
        let payload = payload.as_object().expect("payload object");

        let error = create_skill_from_payload(&root, payload).expect_err("create should fail");

        assert!(
            error.contains("cannot modify built-in Skill"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn install_source_rejects_builtin_skill_names() {
        let tmp = TempDir::new("liveagent-skill-install-builtin-test").expect("temp dir");
        let root = tmp.path().join("skills");
        let source = tmp.path().join("source");
        write_skill(&source, "skills-installer", "Replacement");
        let payload = json!({
            "source": source.to_string_lossy(),
            "conflict": "overwrite"
        });
        let payload = payload.as_object().expect("payload object");

        let error = install_source_from_payload(&root, payload).expect_err("install should fail");

        assert!(
            error.contains("cannot modify built-in Skill"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn safe_extract_zip_rejects_parent_traversal() {
        let tmp = TempDir::new("liveagent-skill-zip-test").expect("temp dir");
        let archive = tmp.path().join("bad.skill");
        {
            let file = fs::File::create(&archive).expect("archive file");
            let mut writer = ZipWriter::new(file);
            let options = FileOptions::default().compression_method(CompressionMethod::Deflated);
            writer
                .start_file("../evil.txt", options)
                .expect("start unsafe file");
            writer.write_all(b"bad").expect("write unsafe file");
            writer.finish().expect("finish archive");
        }

        let error = safe_extract_zip(&archive, &tmp.path().join("out"))
            .expect_err("zip slip should be rejected");
        assert!(error.contains("escapes") || error.contains("unsafe"));
    }
}
