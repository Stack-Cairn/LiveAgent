//! 技能环境变量依赖探测：从脚本与 `metadata.env` 声明中提取运行所需的环境变量。
//!
//! 探测结果驱动前端的「未配置禁止启用」硬门禁，因此精度优先于召回：
//! 误检会把无辜技能锁死在待配置态，漏检只是维持现状（脚本运行时报原始错误）。
//! 分级规则：
//! - 强信号（`required=true`）：脚本文件中的显式环境读取 API（`os.environ`/
//!   `process.env`/`$env:`/`${X:?}` 等，且无默认值），且变量名为凭据形状
//!   （`*_KEY`/`*_TOKEN`/`*_SECRET` 等后缀）；
//! - 弱信号（`required=false`）：Markdown 代码块中的引用（示例代码高发区）、
//!   带默认值的读取、非凭据形状的环境读取、shell 裸 `$VAR`；
//! - 排除：系统/运行时变量否决表，以及技能内脚本自赋值的名字（脚本自己
//!   提供的值不是外部依赖）。
//! `metadata.env` 声明（frontmatter 已允许的自由字段）按名覆盖探测结果。

use regex::Regex;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use walkdir::WalkDir;

use super::*;

/// 单文件扫描字节上限：技能脚本不该更大，超限直接跳过（防御性限制）。
const ENV_SCAN_MAX_FILE_BYTES: u64 = 512 * 1024;
/// 单技能扫描文件数上限。
const ENV_SCAN_MAX_FILES: usize = 400;
/// 每个变量记录的证据文件数上限。
const ENV_SCAN_MAX_SOURCES: usize = 5;
/// `env_status` 一次探测的变量数上限。
pub(crate) const ENV_PROBE_MAX_NAMES: usize = 64;

const SHELL_EXTENSIONS: &[&str] = &["sh", "bash", "zsh"];
const PYTHON_EXTENSIONS: &[&str] = &["py"];
const NODE_EXTENSIONS: &[&str] = &["js", "mjs", "cjs", "ts"];
const POWERSHELL_EXTENSIONS: &[&str] = &["ps1", "psm1"];
const CMD_EXTENSIONS: &[&str] = &["cmd", "bat"];
const RUBY_EXTENSIONS: &[&str] = &["rb"];
const MARKDOWN_EXTENSIONS: &[&str] = &["md", "mdx", "markdown"];

/// 一律排除的变量名（系统、shell、CI、运行时与脚本装饰常量）。
const DENIED_EXACT: &[&str] = &[
    // POSIX / shell 基础
    "PATH", "HOME", "USER", "USERNAME", "LOGNAME", "SHELL", "TERM", "LANG", "LANGUAGE", "TMPDIR",
    "TEMP", "TMP", "PWD", "OLDPWD", "EDITOR", "VISUAL", "PAGER", "HOSTNAME", "IFS", "RANDOM",
    "SECONDS", "LINENO", "FUNCNAME", "SHLVL", "UID", "EUID", "PPID", "HOSTTYPE", "OSTYPE",
    "MACHTYPE", "PS1", "PS2", "PS3", "PS4", "PROMPT", "REPLY", "OPTARG", "OPTIND", "PIPESTATUS",
    "COLUMNS", "LINES",
    // Windows
    "COMPUTERNAME", "USERPROFILE", "USERDOMAIN", "APPDATA", "LOCALAPPDATA", "PROGRAMFILES",
    "PROGRAMDATA", "PROGRAMW6432", "COMSPEC", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "HOMEPATH",
    "HOMEDRIVE", "ALLUSERSPROFILE", "PUBLIC", "PATHEXT", "NUMBER_OF_PROCESSORS", "SESSIONNAME",
    "OS", "LASTEXITCODE", "ERRORLEVEL", "PSHOME", "PSMODULEPATH",
    // 代理 / CI / 常见工具链
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "FTP_PROXY", "CI", "DEBUG", "VERBOSE",
    "NODE_ENV", "NODE_OPTIONS", "NODE_PATH", "PYTHONPATH", "PYTHONHOME", "PYTHONUTF8",
    "PYTHONIOENCODING", "PYTHONDONTWRITEBYTECODE", "PYTHONUNBUFFERED", "VIRTUAL_ENV", "GOPATH",
    "GOROOT", "GOBIN", "JAVA_HOME", "ANDROID_HOME", "GRADLE_HOME", "MAVEN_HOME", "DISPLAY",
    "WAYLAND_DISPLAY", "COLORTERM", "FORCE_COLOR", "NO_COLOR", "CLICOLOR", "LS_COLORS",
    "GITHUB_ACTIONS", "GITHUB_WORKSPACE", "GITHUB_ENV", "GITHUB_OUTPUT", "GITHUB_REPOSITORY",
    "RUNNER_OS", "RUNNER_TEMP", "GIT_DIR", "GIT_EDITOR", "GIT_PAGER", "GIT_SSH_COMMAND",
    "GIT_TERMINAL_PROMPT", "GIT_CONFIG_NOSYSTEM", "SSH_AUTH_SOCK", "SSH_AGENT_PID",
    "SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY", "GPG_TTY", "DBUS_SESSION_BUS_ADDRESS",
    // 技能运行时约定与脚本高频局部名（自赋值过滤之外的兜底）
    "ARGUMENTS", "WORKSPACE_ROOT", "REPO_ROOT", "PROJECT_ROOT", "PROJECT_DIR", "WORKDIR", "CWD",
    "SCRIPT_DIR", "BASE_DIR", "BASEDIR", "ROOT_DIR", "OUTPUT_DIR", "INPUT_DIR", "LOG_FILE",
    "LOG_DIR", "LOG_LEVEL", "ENV_FILE", "CONFIG_FILE", "CONFIG_DIR", "CACHE_DIR", "DATA_DIR",
    // 终端颜色常量
    "RED", "GREEN", "YELLOW", "BLUE", "MAGENTA", "CYAN", "WHITE", "BLACK", "GRAY", "GREY", "BOLD",
    "DIM", "ITALIC", "UNDERLINE", "BLINK", "REVERSE", "RESET", "NC",
];

/// 按前缀排除的变量名（基础设施命名空间；凭据不会用这些前缀）。
const DENIED_PREFIXES: &[&str] = &[
    "XDG_", "LC_", "BASH_", "ZSH_", "PROCESSOR_", "MSYS", "MINGW", "CYGWIN", "WSL_", "CLAUDE_",
    "SKILL_", "SKILLS_", "LIVEAGENT_", "CONDA_", "NVM_", "PYENV_", "CARGO_", "RUSTUP_", "DOTNET_",
    "TERM_", "SYSTEMD_", "TAURI_",
];

/// 凭据形状后缀：命中才允许升为强信号。
const CREDENTIAL_SUFFIXES: &[&str] = &[
    "_API_KEY", "_APIKEY", "_KEY", "_TOKEN", "_SECRET", "_PASSWORD", "_PASSWD", "_CREDENTIAL",
    "_CREDENTIALS", "_DSN", "_AUTH", "_ACCESS_KEY_ID", "_SECRET_ACCESS_KEY",
];
const CREDENTIAL_EXACT: &[&str] = &[
    "API_KEY", "APIKEY", "TOKEN", "SECRET", "PASSWORD", "ACCESS_TOKEN", "AUTH_TOKEN", "DSN",
];

pub(crate) fn is_valid_env_var_name(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !(first.is_ascii_alphabetic() || first == '_') {
        return false;
    }
    name.len() <= 128 && chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

/// 进程环境中该变量当前是否有非空值（每次现场探测，不缓存）。
pub(crate) fn probe_env_var_present(name: &str) -> bool {
    if !is_valid_env_var_name(name) {
        return false;
    }
    std::env::var(name)
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
}

fn is_denied_env_name(name: &str) -> bool {
    DENIED_EXACT.contains(&name) || DENIED_PREFIXES.iter().any(|prefix| name.starts_with(prefix))
}

fn is_credential_shaped(name: &str) -> bool {
    CREDENTIAL_EXACT.contains(&name)
        || CREDENTIAL_SUFFIXES.iter().any(|suffix| name.ends_with(suffix))
}

/// 扫描到的单条引用强度。数值越大优先级越高，聚合时取最大值。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum SignalStrength {
    /// 裸引用或带默认值的读取。
    Weak,
    /// 显式环境读取 API 且无默认值（还需凭据形状才最终判强）。
    StrongEligible,
}

struct Scanners {
    py_environ_index: Regex,
    py_get_no_default: Regex,
    py_get_with_default: Regex,
    node_env: Regex,
    pwsh_env: Regex,
    shell_required: Regex,
    shell_with_default: Regex,
    shell_plain: Regex,
    cmd_var: Regex,
    ruby_env: Regex,
    assign_shell: Regex,
    assign_shell_for: Regex,
    assign_shell_read: Regex,
    assign_pwsh: Regex,
    assign_py: Regex,
    assign_node: Regex,
    assign_cmd: Regex,
    fence: Regex,
}

fn scanners() -> &'static Scanners {
    static SCANNERS: OnceLock<Scanners> = OnceLock::new();
    SCANNERS.get_or_init(|| {
        let compile = |pattern: &str| Regex::new(pattern).expect("static env scan regex");
        Scanners {
            py_environ_index: compile(
                r#"os\s*\.\s*environ\s*\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\]"#,
            ),
            py_get_no_default: compile(
                r#"os\s*\.\s*(?:environ\s*\.\s*get|getenv)\s*\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\)"#,
            ),
            py_get_with_default: compile(
                r#"os\s*\.\s*(?:environ\s*\.\s*get|getenv)\s*\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*,"#,
            ),
            node_env: compile(
                r#"process\s*\.\s*env\s*(?:\.\s*([A-Za-z_][A-Za-z0-9_]*)|\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\])"#,
            ),
            pwsh_env: compile(r"\$(?i:env):([A-Za-z_][A-Za-z0-9_]*)"),
            shell_required: compile(r"\$\{([A-Z][A-Z0-9_]{2,}):?\?"),
            shell_with_default: compile(r"\$\{([A-Z][A-Z0-9_]{2,}):?[-=+]"),
            shell_plain: compile(r"\$\{?([A-Z][A-Z0-9_]{2,})\}?"),
            cmd_var: compile(r"%([A-Z][A-Z0-9_]{2,})%"),
            ruby_env: compile(r#"\bENV\s*\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\]"#),
            assign_shell: compile(
                r"(?m)^[ \t]*(?:export[ \t]+|local[ \t]+|readonly[ \t]+|declare[ \t]+(?:-[A-Za-z]+[ \t]+)?)?([A-Z][A-Z0-9_]{2,})=",
            ),
            assign_shell_for: compile(r"\bfor[ \t]+([A-Z][A-Z0-9_]{2,})[ \t]+in\b"),
            assign_shell_read: compile(r"\bread[ \t]+(?:-[A-Za-z]+[ \t]+)*([A-Z][A-Z0-9_]{2,})\b"),
            assign_pwsh: compile(r"\$(?i:env):([A-Za-z_][A-Za-z0-9_]*)\s*=[^=]"),
            assign_py: compile(
                r#"os\s*\.\s*environ\s*\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\]\s*=[^=]"#,
            ),
            assign_node: compile(
                r#"process\s*\.\s*env\s*(?:\.\s*([A-Za-z_][A-Za-z0-9_]*)|\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\])\s*=[^=]"#,
            ),
            assign_cmd: compile(r#"(?mi)^[ \t]*set[ \t]+"?([A-Za-z_][A-Za-z0-9_]*)="#),
            fence: compile(r"(?ms)^[ \t]*(?:```|~~~)[^\n]*\n(.*?)^[ \t]*(?:```|~~~)[ \t]*$"),
        }
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ScriptLanguage {
    Shell,
    Python,
    Node,
    PowerShell,
    Cmd,
    Ruby,
}

fn script_language_for_extension(ext: &str) -> Option<ScriptLanguage> {
    let ext = ext.to_ascii_lowercase();
    let ext = ext.as_str();
    if SHELL_EXTENSIONS.contains(&ext) {
        Some(ScriptLanguage::Shell)
    } else if PYTHON_EXTENSIONS.contains(&ext) {
        Some(ScriptLanguage::Python)
    } else if NODE_EXTENSIONS.contains(&ext) {
        Some(ScriptLanguage::Node)
    } else if POWERSHELL_EXTENSIONS.contains(&ext) {
        Some(ScriptLanguage::PowerShell)
    } else if CMD_EXTENSIONS.contains(&ext) {
        Some(ScriptLanguage::Cmd)
    } else if RUBY_EXTENSIONS.contains(&ext) {
        Some(ScriptLanguage::Ruby)
    } else {
        None
    }
}

fn is_markdown_extension(ext: &str) -> bool {
    MARKDOWN_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str())
}

/// 单个文件里收集到的读取与自赋值。
#[derive(Debug, Default)]
struct FileScan {
    reads: Vec<(String, SignalStrength)>,
    assigned: BTreeSet<String>,
}

fn collect_reads(scan: &mut FileScan, regex: &Regex, content: &str, strength: SignalStrength) {
    for captures in regex.captures_iter(content) {
        let name = captures
            .iter()
            .skip(1)
            .flatten()
            .next()
            .map(|m| m.as_str().to_string());
        if let Some(name) = name {
            scan.reads.push((name, strength));
        }
    }
}

fn collect_assigned(scan: &mut FileScan, regex: &Regex, content: &str) {
    for captures in regex.captures_iter(content) {
        for group in captures.iter().skip(1).flatten() {
            scan.assigned.insert(group.as_str().to_string());
        }
    }
}

fn scan_language_content(scan: &mut FileScan, language: ScriptLanguage, content: &str) {
    let scanners = scanners();
    match language {
        ScriptLanguage::Shell => {
            collect_reads(scan, &scanners.shell_required, content, SignalStrength::StrongEligible);
            collect_reads(scan, &scanners.shell_with_default, content, SignalStrength::Weak);
            collect_reads(scan, &scanners.shell_plain, content, SignalStrength::Weak);
            collect_assigned(scan, &scanners.assign_shell, content);
            collect_assigned(scan, &scanners.assign_shell_for, content);
            collect_assigned(scan, &scanners.assign_shell_read, content);
        }
        ScriptLanguage::Python => {
            collect_reads(scan, &scanners.py_environ_index, content, SignalStrength::StrongEligible);
            collect_reads(scan, &scanners.py_get_no_default, content, SignalStrength::StrongEligible);
            collect_reads(scan, &scanners.py_get_with_default, content, SignalStrength::Weak);
            collect_assigned(scan, &scanners.assign_py, content);
        }
        ScriptLanguage::Node => {
            collect_reads(scan, &scanners.node_env, content, SignalStrength::StrongEligible);
            collect_assigned(scan, &scanners.assign_node, content);
        }
        ScriptLanguage::PowerShell => {
            collect_reads(scan, &scanners.pwsh_env, content, SignalStrength::StrongEligible);
            collect_assigned(scan, &scanners.assign_pwsh, content);
        }
        ScriptLanguage::Cmd => {
            collect_reads(scan, &scanners.cmd_var, content, SignalStrength::Weak);
            collect_assigned(scan, &scanners.assign_cmd, content);
        }
        ScriptLanguage::Ruby => {
            collect_reads(scan, &scanners.ruby_env, content, SignalStrength::StrongEligible);
        }
    }
}

/// Markdown 代码块统一按弱信号处理：示例代码不能驱动硬门禁。
fn scan_markdown_fences(scan: &mut FileScan, content: &str) {
    let scanners = scanners();
    for captures in scanners.fence.captures_iter(content) {
        let Some(block) = captures.get(1).map(|m| m.as_str()) else {
            continue;
        };
        let mut fence_scan = FileScan::default();
        for language in [
            ScriptLanguage::Shell,
            ScriptLanguage::Python,
            ScriptLanguage::Node,
            ScriptLanguage::PowerShell,
        ] {
            scan_language_content(&mut fence_scan, language, block);
        }
        for (name, _) in fence_scan.reads {
            scan.reads.push((name, SignalStrength::Weak));
        }
        scan.assigned.extend(fence_scan.assigned);
    }
}

/// `metadata.env` 声明条目（frontmatter 或 skill.json 的 metadata 自由字段）。
#[derive(Debug, Clone, Default)]
struct DeclaredEnvEntry {
    name: String,
    provider: Option<String>,
    description: Option<String>,
    url: Option<String>,
    optional: bool,
}

/// 从 frontmatter YAML 中解析 `metadata:` 块下的 `env:` 列表。
///
/// 与 [`parse_yaml_top_level_scalar`] 同风格的手写窄解析：只认本仓约定的
/// 缩进结构，容错优先（解析不出就当没有声明），绝不让格式问题阻断列表。
fn parse_declared_env_from_yaml(yaml: &str) -> Vec<DeclaredEnvEntry> {
    let lines: Vec<&str> = yaml.lines().collect();
    let mut index = 0;
    // 定位顶层 metadata: 块。
    while index < lines.len() {
        let line = lines[index];
        index += 1;
        if line.trim_end() == "metadata:" && !line.starts_with([' ', '\t']) {
            break;
        }
        if index == lines.len() {
            return Vec::new();
        }
    }
    if index >= lines.len() {
        return Vec::new();
    }

    // metadata 块 = 后续所有缩进更深的行。
    let mut block: Vec<&str> = Vec::new();
    while index < lines.len() {
        let line = lines[index];
        if !line.trim().is_empty() && !line.starts_with([' ', '\t']) {
            break;
        }
        block.push(line);
        index += 1;
    }

    // 定位块内 env: 行并记录其缩进。
    let mut env_indent = None;
    let mut cursor = 0;
    for (position, line) in block.iter().enumerate() {
        let trimmed = line.trim();
        if trimmed == "env:" {
            env_indent = Some(indent_width(line));
            cursor = position + 1;
            break;
        }
    }
    let Some(env_indent) = env_indent else {
        return Vec::new();
    };

    let mut entries: Vec<DeclaredEnvEntry> = Vec::new();
    let mut current: Option<DeclaredEnvEntry> = None;
    let mut item_indent = None;
    for line in block.iter().skip(cursor) {
        if line.trim().is_empty() {
            continue;
        }
        let indent = indent_width(line);
        if indent <= env_indent {
            break;
        }
        let trimmed = line.trim();
        if let Some(rest) = trimmed
            .strip_prefix("- ")
            .or_else(|| trimmed.strip_prefix('-'))
        {
            if item_indent.is_none() {
                item_indent = Some(indent);
            }
            if indent != item_indent.unwrap_or(indent) {
                break;
            }
            if let Some(entry) = current.take() {
                entries.push(entry);
            }
            let rest = rest.trim();
            let mut entry = DeclaredEnvEntry::default();
            if let Some((key, value)) = rest.split_once(':') {
                apply_declared_field(&mut entry, key.trim(), value);
            } else if !rest.is_empty() {
                entry.name = unquote_yaml_scalar(rest);
            }
            current = Some(entry);
            continue;
        }
        // 列表项的续行：key: value。
        let Some(entry) = current.as_mut() else {
            continue;
        };
        if let Some((key, value)) = trimmed.split_once(':') {
            apply_declared_field(entry, key.trim(), value);
        }
    }
    if let Some(entry) = current.take() {
        entries.push(entry);
    }

    entries
        .into_iter()
        .filter(|entry| is_valid_env_var_name(&entry.name))
        .collect()
}

fn indent_width(line: &str) -> usize {
    line.chars().take_while(|ch| *ch == ' ' || *ch == '\t').count()
}

fn apply_declared_field(entry: &mut DeclaredEnvEntry, key: &str, raw_value: &str) {
    let value = unquote_yaml_scalar(raw_value);
    match key {
        "name" => entry.name = value,
        "provider" => entry.provider = normalize_skill_metadata_value(Some(value)),
        "description" => entry.description = normalize_skill_metadata_value(Some(value)),
        "url" => entry.url = normalize_skill_metadata_value(Some(value)),
        "optional" => entry.optional = value.eq_ignore_ascii_case("true"),
        _ => {}
    }
}

/// 从 skill.json 的 `metadata.env` 数组解析声明（字符串或对象两种条目形式）。
fn parse_declared_env_from_json(json_text: &str) -> Vec<DeclaredEnvEntry> {
    let Ok(parsed) = serde_json::from_str::<Value>(strip_utf8_bom(json_text)) else {
        return Vec::new();
    };
    let Some(items) = parsed
        .get("metadata")
        .and_then(|metadata| metadata.get("env"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };

    items
        .iter()
        .filter_map(|item| match item {
            Value::String(name) => Some(DeclaredEnvEntry {
                name: name.trim().to_string(),
                ..DeclaredEnvEntry::default()
            }),
            Value::Object(fields) => {
                let string_field = |key: &str| {
                    fields
                        .get(key)
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(ToOwned::to_owned)
                };
                Some(DeclaredEnvEntry {
                    name: string_field("name")?,
                    provider: string_field("provider"),
                    description: string_field("description"),
                    url: string_field("url"),
                    optional: fields.get("optional").and_then(Value::as_bool).unwrap_or(false),
                })
            }
            _ => None,
        })
        .filter(|entry| is_valid_env_var_name(&entry.name))
        .collect()
}

fn read_declared_env(skill_dir: &Path) -> Vec<DeclaredEnvEntry> {
    let Some(metadata_file) = metadata_file_for(skill_dir) else {
        return Vec::new();
    };
    let Ok(metadata) = fs::metadata(&metadata_file) else {
        return Vec::new();
    };
    if metadata.len() > ENV_SCAN_MAX_FILE_BYTES {
        return Vec::new();
    }
    let Ok(content) = fs::read_to_string(&metadata_file) else {
        return Vec::new();
    };
    if is_skill_json(&metadata_file) {
        return parse_declared_env_from_json(&content);
    }
    let Ok((yaml, _body)) = split_frontmatter(&content) else {
        return Vec::new();
    };
    parse_declared_env_from_yaml(&yaml)
}

/// 不含系统探测结果的扫描条目（可按目录签名缓存的部分）。
#[derive(Debug, Clone)]
struct ScannedEnvEntry {
    name: String,
    required: bool,
    confidence: &'static str,
    provider: Option<String>,
    description: Option<String>,
    url: Option<String>,
    sources: Vec<String>,
}

struct CachedEnvScan {
    signature: u64,
    entries: Vec<ScannedEnvEntry>,
}

fn env_scan_cache() -> &'static Mutex<HashMap<PathBuf, CachedEnvScan>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, CachedEnvScan>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 扫描候选文件列表（脚本 + Markdown + skill.json），带数量上限，路径排序保证签名稳定。
fn scan_candidates(skill_dir: &Path) -> Vec<(PathBuf, String)> {
    let mut candidates = Vec::new();
    for entry in WalkDir::new(skill_dir)
        .follow_links(false)
        .min_depth(1)
        .into_iter()
        .filter_entry(|entry| {
            !entry
                .file_name()
                .to_string_lossy()
                .starts_with('.')
        })
    {
        let Ok(entry) = entry else {
            continue;
        };
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let extension = path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(str::to_ascii_lowercase)
            .unwrap_or_default();
        let is_candidate = script_language_for_extension(&extension).is_some()
            || is_markdown_extension(&extension)
            || is_skill_json(path);
        if !is_candidate {
            continue;
        }
        let rel = path
            .strip_prefix(skill_dir)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");
        candidates.push((path.to_path_buf(), rel));
        if candidates.len() >= ENV_SCAN_MAX_FILES {
            break;
        }
    }
    candidates.sort_by(|a, b| a.1.cmp(&b.1));
    candidates
}

/// 目录签名：候选文件的 (相对路径, mtime, size) 有序哈希。文件内容不参与，
/// 变更通过 mtime/size 体现；签名不变即复用缓存，避免每次列表都全量读文件。
fn scan_signature(candidates: &[(PathBuf, String)]) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    for (path, rel) in candidates {
        rel.hash(&mut hasher);
        if let Ok(metadata) = fs::metadata(path) {
            metadata.len().hash(&mut hasher);
            if let Ok(modified) = metadata.modified() {
                if let Ok(duration) = modified.duration_since(std::time::UNIX_EPOCH) {
                    duration.as_millis().hash(&mut hasher);
                }
            }
        }
    }
    hasher.finish()
}

fn run_env_scan(skill_dir: &Path, candidates: &[(PathBuf, String)]) -> Vec<ScannedEnvEntry> {
    // 聚合：变量名 -> (最高强度, 是否见过带默认值的形式, 证据文件)。
    #[derive(Default)]
    struct Aggregate {
        strength: Option<SignalStrength>,
        strong_context: bool,
        sources: BTreeSet<String>,
    }
    let mut aggregates: BTreeMap<String, Aggregate> = BTreeMap::new();
    let mut assigned_anywhere: BTreeSet<String> = BTreeSet::new();

    for (path, rel) in candidates {
        let Ok(metadata) = fs::metadata(path) else {
            continue;
        };
        if metadata.len() > ENV_SCAN_MAX_FILE_BYTES {
            continue;
        }
        let Ok(content) = fs::read_to_string(path) else {
            continue;
        };

        let extension = path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(str::to_ascii_lowercase)
            .unwrap_or_default();
        let mut file_scan = FileScan::default();
        let mut strong_context = false;
        if let Some(language) = script_language_for_extension(&extension) {
            scan_language_content(&mut file_scan, language, &content);
            strong_context = true;
        } else if is_markdown_extension(&extension) {
            scan_markdown_fences(&mut file_scan, &content);
        } else {
            continue;
        }

        assigned_anywhere.extend(file_scan.assigned.iter().cloned());
        for (name, strength) in file_scan.reads {
            if !is_valid_env_var_name(&name) {
                continue;
            }
            let normalized = name;
            let aggregate = aggregates.entry(normalized).or_default();
            let effective = if strong_context {
                strength
            } else {
                SignalStrength::Weak
            };
            aggregate.strength = Some(match aggregate.strength {
                Some(existing) => existing.max(effective),
                None => effective,
            });
            if strong_context && effective == SignalStrength::StrongEligible {
                aggregate.strong_context = true;
            }
            if aggregate.sources.len() < ENV_SCAN_MAX_SOURCES {
                aggregate.sources.insert(rel.clone());
            }
        }
    }

    let declared = read_declared_env(skill_dir);
    let mut declared_names: BTreeSet<String> = BTreeSet::new();
    let mut entries: Vec<ScannedEnvEntry> = Vec::new();

    // 声明条目优先输出，按声明顺序；同名探测证据并入 sources。
    for entry in declared {
        if declared_names.contains(&entry.name) {
            continue;
        }
        declared_names.insert(entry.name.clone());
        let sources = aggregates
            .get(&entry.name)
            .map(|aggregate| aggregate.sources.iter().cloned().collect())
            .unwrap_or_default();
        entries.push(ScannedEnvEntry {
            name: entry.name,
            required: !entry.optional,
            confidence: "declared",
            provider: entry.provider,
            description: entry.description,
            url: entry.url,
            sources,
        });
    }

    for (name, aggregate) in aggregates {
        if declared_names.contains(&name) || is_denied_env_name(&name) {
            continue;
        }
        if assigned_anywhere.contains(&name) {
            continue;
        }
        let strong = aggregate.strong_context
            && aggregate.strength == Some(SignalStrength::StrongEligible)
            && is_credential_shaped(&name);
        entries.push(ScannedEnvEntry {
            name,
            required: strong,
            confidence: if strong { "strong" } else { "weak" },
            provider: None,
            description: None,
            url: None,
            sources: aggregate.sources.into_iter().collect(),
        });
    }

    entries
}

/// 技能环境变量依赖（含现场系统探测）。签名未变时复用缓存的扫描结果，
/// 系统探测每次实时执行——环境变量随时可能变化，不能缓存。
pub(crate) fn skill_env_requirements(skill_dir: &Path) -> Vec<SystemSkillEnvRequirement> {
    let candidates = scan_candidates(skill_dir);
    let signature = scan_signature(&candidates);

    let cache = env_scan_cache();
    let cached_entries = {
        let guard = cache.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        guard
            .get(skill_dir)
            .filter(|cached| cached.signature == signature)
            .map(|cached| cached.entries.clone())
    };

    let entries = match cached_entries {
        Some(entries) => entries,
        None => {
            let entries = run_env_scan(skill_dir, &candidates);
            let mut guard = cache.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            guard.insert(
                skill_dir.to_path_buf(),
                CachedEnvScan {
                    signature,
                    entries: entries.clone(),
                },
            );
            entries
        }
    };

    entries
        .into_iter()
        .map(|entry| SystemSkillEnvRequirement {
            system_value_present: probe_env_var_present(&entry.name),
            name: entry.name,
            required: entry.required,
            confidence: entry.confidence.to_string(),
            provider: entry.provider,
            description: entry.description,
            url: entry.url,
            sources: entry.sources,
        })
        .collect()
}

/// `env_status` 动作：按名探测进程环境变量是否有非空值。
pub(crate) fn probe_env_names(names: &[String]) -> Vec<SystemSkillEnvProbeResult> {
    names
        .iter()
        .take(ENV_PROBE_MAX_NAMES)
        .filter(|name| is_valid_env_var_name(name))
        .map(|name| SystemSkillEnvProbeResult {
            name: name.clone(),
            present: probe_env_var_present(name),
        })
        .collect()
}

#[cfg(test)]
mod env_tests {
    use super::*;

    fn write_skill(files: &[(&str, &str)]) -> TempDir {
        let dir = TempDir::new("liveagent-env-scan-test").expect("temp skill dir");
        for (rel, content) in files {
            let path = dir.path().join(rel);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).expect("create skill subdir");
            }
            fs::write(path, content).expect("write skill file");
        }
        dir
    }

    fn requirement<'a>(
        requirements: &'a [SystemSkillEnvRequirement],
        name: &str,
    ) -> Option<&'a SystemSkillEnvRequirement> {
        requirements.iter().find(|entry| entry.name == name)
    }

    #[test]
    fn python_env_read_with_credential_name_is_strong() {
        let dir = write_skill(&[
            ("SKILL.md", "---\nname: t\ndescription: d\n---\nbody"),
            ("scripts/run.py", "import os\nkey = os.environ[\"FOO_API_KEY\"]\n"),
        ]);
        let requirements = skill_env_requirements(dir.path());
        let entry = requirement(&requirements, "FOO_API_KEY").expect("detected");
        assert!(entry.required);
        assert_eq!(entry.confidence, "strong");
        assert_eq!(entry.sources, vec!["scripts/run.py".to_string()]);
    }

    #[test]
    fn python_get_with_default_is_weak() {
        let dir = write_skill(&[(
            "scripts/run.py",
            "import os\nkey = os.environ.get(\"FOO_API_KEY\", \"\")\n",
        )]);
        let requirements = skill_env_requirements(dir.path());
        let entry = requirement(&requirements, "FOO_API_KEY").expect("detected");
        assert!(!entry.required);
        assert_eq!(entry.confidence, "weak");
    }

    #[test]
    fn markdown_fence_reference_stays_weak() {
        let dir = write_skill(&[(
            "SKILL.md",
            "---\nname: t\ndescription: d\n---\n```python\nimport os\nos.environ[\"STRIPE_SECRET_KEY\"]\n```\n",
        )]);
        let requirements = skill_env_requirements(dir.path());
        let entry = requirement(&requirements, "STRIPE_SECRET_KEY").expect("detected");
        assert!(!entry.required);
        assert_eq!(entry.confidence, "weak");
    }

    #[test]
    fn self_assigned_shell_variable_is_excluded() {
        let dir = write_skill(&[(
            "scripts/run.sh",
            "#!/usr/bin/env bash\nGREEN='\\033[0;32m'\necho \"${GREEN}ok\"\n",
        )]);
        let requirements = skill_env_requirements(dir.path());
        assert!(requirement(&requirements, "GREEN").is_none());
    }

    #[test]
    fn denied_system_names_are_excluded() {
        let dir = write_skill(&[(
            "scripts/run.py",
            "import os\nos.environ[\"HOME\"]\nos.environ[\"XDG_CONFIG_HOME\"]\n",
        )]);
        let requirements = skill_env_requirements(dir.path());
        assert!(requirement(&requirements, "HOME").is_none());
        assert!(requirement(&requirements, "XDG_CONFIG_HOME").is_none());
    }

    #[test]
    fn non_credential_env_read_is_weak() {
        let dir = write_skill(&[(
            "scripts/run.py",
            "import os\nregion = os.environ[\"WEATHER_REGION\"]\n",
        )]);
        let requirements = skill_env_requirements(dir.path());
        let entry = requirement(&requirements, "WEATHER_REGION").expect("detected");
        assert!(!entry.required);
        assert_eq!(entry.confidence, "weak");
    }

    #[test]
    fn shell_required_expansion_is_strong_for_credentials() {
        let dir = write_skill(&[(
            "scripts/run.sh",
            "#!/usr/bin/env bash\ncurl -H \"Authorization: ${OPENWEATHER_API_KEY:?missing}\"\n",
        )]);
        let requirements = skill_env_requirements(dir.path());
        let entry = requirement(&requirements, "OPENWEATHER_API_KEY").expect("detected");
        assert!(entry.required);
        assert_eq!(entry.confidence, "strong");
    }

    #[test]
    fn declared_metadata_env_overrides_detection() {
        let dir = write_skill(&[
            (
                "SKILL.md",
                concat!(
                    "---\n",
                    "name: t\n",
                    "description: d\n",
                    "metadata:\n",
                    "  env:\n",
                    "    - name: OPENWEATHER_API_KEY\n",
                    "      provider: OpenWeather\n",
                    "      url: https://example.com/keys\n",
                    "    - name: WEATHER_UNITS\n",
                    "      optional: true\n",
                    "---\n",
                    "body\n",
                ),
            ),
            ("scripts/run.py", "import os\nos.environ[\"OPENWEATHER_API_KEY\"]\n"),
        ]);
        let requirements = skill_env_requirements(dir.path());
        let key = requirement(&requirements, "OPENWEATHER_API_KEY").expect("declared");
        assert!(key.required);
        assert_eq!(key.confidence, "declared");
        assert_eq!(key.provider.as_deref(), Some("OpenWeather"));
        assert_eq!(key.url.as_deref(), Some("https://example.com/keys"));
        assert_eq!(key.sources, vec!["scripts/run.py".to_string()]);
        let units = requirement(&requirements, "WEATHER_UNITS").expect("declared optional");
        assert!(!units.required);
    }

    #[test]
    fn skill_json_metadata_env_is_parsed() {
        let dir = write_skill(&[(
            "skill.json",
            r#"{"name":"t","description":"d","metadata":{"env":["FOO_TOKEN",{"name":"BAR_KEY","provider":"Bar","optional":true}]}}"#,
        )]);
        let requirements = skill_env_requirements(dir.path());
        let foo = requirement(&requirements, "FOO_TOKEN").expect("string entry");
        assert!(foo.required);
        assert_eq!(foo.confidence, "declared");
        let bar = requirement(&requirements, "BAR_KEY").expect("object entry");
        assert!(!bar.required);
        assert_eq!(bar.provider.as_deref(), Some("Bar"));
    }

    #[test]
    fn scan_cache_reuses_results_until_files_change() {
        let dir = write_skill(&[(
            "scripts/run.py",
            "import os\nos.environ[\"CACHE_TEST_API_KEY\"]\n",
        )]);
        let first = skill_env_requirements(dir.path());
        let second = skill_env_requirements(dir.path());
        assert_eq!(first.len(), second.len());
        assert!(requirement(&second, "CACHE_TEST_API_KEY").is_some());
    }

    #[test]
    fn probe_env_names_filters_invalid_and_caps() {
        let results = probe_env_names(&[
            "PATH".to_string(),
            "not a name".to_string(),
            "LIVEAGENT_TEST_SURELY_UNSET_VAR".to_string(),
        ]);
        assert_eq!(results.len(), 2);
        assert!(results.iter().any(|entry| entry.name == "PATH" && entry.present));
        assert!(results
            .iter()
            .any(|entry| entry.name == "LIVEAGENT_TEST_SURELY_UNSET_VAR" && !entry.present));
    }

    #[test]
    fn env_var_name_validation() {
        assert!(is_valid_env_var_name("FOO_API_KEY"));
        assert!(is_valid_env_var_name("_PRIVATE"));
        assert!(!is_valid_env_var_name(""));
        assert!(!is_valid_env_var_name("1BAD"));
        assert!(!is_valid_env_var_name("BAD NAME"));
        assert!(!is_valid_env_var_name("BAD-NAME"));
    }
}
