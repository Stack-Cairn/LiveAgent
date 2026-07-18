//! 扫描本机其他 AI 工具（Claude Code / Codex / Claude Desktop）已配置的 MCP
//! Server，供 MCP Hub「本地导入」页展示后由用户勾选导入。导入本身是纯前端
//! 设置写入（追加进 `AppSettings.mcp.servers`），这里只负责读取与解析配置。
//!
//! 解析全部容错：单个文件 / 单个条目解析失败只记入 `errors`，绝不让整个
//! 扫描失败。凡是值里带 `${VAR}` 展开语法的按原样保留，由用户导入后自行调整。

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde_json::Value;

use super::types::{SystemExternalMcpServerEntry, SystemExternalMcpToolScan};
use crate::runtime::platform::expand_tilde_path;

const TRANSPORT_STDIO: &str = "stdio";
const TRANSPORT_HTTP: &str = "http";
const TRANSPORT_SSE: &str = "sse";

pub(crate) fn scan_external_mcp_servers() -> Vec<SystemExternalMcpToolScan> {
    vec![
        scan_claude_code(),
        scan_codex(),
        scan_claude_desktop(),
    ]
}

fn scan_claude_code() -> SystemExternalMcpToolScan {
    // Claude Code 的 MCP 配置分布在两处：
    // - ~/.claude.json：顶层 `mcpServers`（用户级）+ `projects.<路径>.mcpServers`（项目本地级）
    // - ~/.mcp.json：项目共享级配置（在 home 启动会话时生效）
    let mut servers = Vec::new();
    let mut errors = Vec::new();
    let mut scanned_paths = Vec::new();

    let claude_json = expand_tilde_path("~/.claude.json");
    if claude_json.is_file() {
        scanned_paths.push("~/.claude.json".to_string());
        match read_json(&claude_json) {
            Ok(root) => {
                collect_json_server_map(root.get("mcpServers"), "user", &mut servers, &mut errors);
                if let Some(projects) = root.get("projects").and_then(Value::as_object) {
                    for (project_path, project) in projects {
                        collect_json_server_map(
                            project.get("mcpServers"),
                            project_path,
                            &mut servers,
                            &mut errors,
                        );
                    }
                }
            }
            Err(err) => errors.push(err),
        }
    }

    let mcp_json = expand_tilde_path("~/.mcp.json");
    if mcp_json.is_file() {
        scanned_paths.push("~/.mcp.json".to_string());
        match read_json(&mcp_json) {
            Ok(root) => {
                collect_json_server_map(root.get("mcpServers"), "user", &mut servers, &mut errors);
            }
            Err(err) => errors.push(err),
        }
    }

    finish_scan("claude-code", scanned_paths, "~/.claude.json", servers, errors)
}

fn scan_codex() -> SystemExternalMcpToolScan {
    let mut servers = Vec::new();
    let mut errors = Vec::new();
    let mut scanned_paths = Vec::new();

    let config_toml = expand_tilde_path("~/.codex/config.toml");
    if config_toml.is_file() {
        scanned_paths.push("~/.codex/config.toml".to_string());
        match std::fs::read_to_string(&config_toml) {
            Ok(text) => parse_codex_toml(&text, &mut servers, &mut errors),
            Err(err) => errors.push(format!("Failed to read {}: {err}", config_toml.display())),
        }
    }

    finish_scan("codex", scanned_paths, "~/.codex/config.toml", servers, errors)
}

fn scan_claude_desktop() -> SystemExternalMcpToolScan {
    // Windows: %APPDATA%/Claude；macOS: ~/Library/Application Support/Claude；
    // Linux: ~/.config/Claude。dirs::config_dir 与三者一一对应。
    let mut servers = Vec::new();
    let mut errors = Vec::new();
    let mut scanned_paths = Vec::new();

    let config_path = claude_desktop_config_path();
    let display_path = config_path
        .as_ref()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|| "Claude/claude_desktop_config.json".to_string());
    if let Some(path) = config_path {
        if path.is_file() {
            scanned_paths.push(display_path.clone());
            match read_json(&path) {
                Ok(root) => {
                    collect_json_server_map(
                        root.get("mcpServers"),
                        "user",
                        &mut servers,
                        &mut errors,
                    );
                }
                Err(err) => errors.push(err),
            }
        }
    }

    finish_scan("claude-desktop", scanned_paths, &display_path, servers, errors)
}

fn claude_desktop_config_path() -> Option<PathBuf> {
    dirs::config_dir().map(|dir| dir.join("Claude").join("claude_desktop_config.json"))
}

fn finish_scan(
    tool: &str,
    scanned_paths: Vec<String>,
    default_path: &str,
    mut servers: Vec<SystemExternalMcpServerEntry>,
    errors: Vec<String>,
) -> SystemExternalMcpToolScan {
    let exists = !scanned_paths.is_empty();
    // 同名条目（多作用域声明同一 server）保留先出现的：用户级先扫，优先级更直观。
    let mut seen = std::collections::HashSet::new();
    servers.retain(|server| seen.insert(server.id.to_lowercase()));
    servers.sort_by(|a, b| a.id.to_lowercase().cmp(&b.id.to_lowercase()));
    SystemExternalMcpToolScan {
        tool: tool.to_string(),
        config_path: if scanned_paths.is_empty() {
            default_path.to_string()
        } else {
            scanned_paths.join(" + ")
        },
        exists,
        servers,
        errors,
    }
}

fn read_json(path: &std::path::Path) -> Result<Value, String> {
    let text = std::fs::read_to_string(path)
        .map_err(|err| format!("Failed to read {}: {err}", path.display()))?;
    serde_json::from_str(&text).map_err(|err| format!("Failed to parse {}: {err}", path.display()))
}

/// 解析 Claude Code / Claude Desktop 风格的 `mcpServers` JSON 对象。
pub(crate) fn collect_json_server_map(
    map: Option<&Value>,
    origin: &str,
    servers: &mut Vec<SystemExternalMcpServerEntry>,
    errors: &mut Vec<String>,
) {
    let Some(map) = map.and_then(Value::as_object) else {
        return;
    };
    for (name, entry) in map {
        match json_entry_to_server(name, entry, origin) {
            Ok(server) => servers.push(server),
            Err(err) => errors.push(err),
        }
    }
}

fn json_entry_to_server(
    name: &str,
    entry: &Value,
    origin: &str,
) -> Result<SystemExternalMcpServerEntry, String> {
    let entry = entry
        .as_object()
        .ok_or_else(|| format!("MCP server \"{name}\" is not an object"))?;
    let command = string_field(entry.get("command"));
    let url = string_field(entry.get("url"));
    let declared_type = string_field(entry.get("type")).to_lowercase();

    let transport = match declared_type.as_str() {
        TRANSPORT_HTTP | "streamable-http" | "streamable_http" => TRANSPORT_HTTP,
        TRANSPORT_SSE => TRANSPORT_SSE,
        TRANSPORT_STDIO => TRANSPORT_STDIO,
        // type 缺省时按字段推断：command → stdio；url → http。
        "" if !command.is_empty() => TRANSPORT_STDIO,
        "" if !url.is_empty() => TRANSPORT_HTTP,
        other => {
            return Err(format!(
                "MCP server \"{name}\" has unsupported type \"{other}\""
            ))
        }
    };
    if transport == TRANSPORT_STDIO && command.is_empty() {
        return Err(format!("MCP server \"{name}\" is missing command"));
    }
    if transport != TRANSPORT_STDIO && url.is_empty() {
        return Err(format!("MCP server \"{name}\" is missing url"));
    }

    Ok(SystemExternalMcpServerEntry {
        id: name.to_string(),
        transport: transport.to_string(),
        command,
        args: string_list(entry.get("args")),
        url,
        env: string_map(entry.get("env")),
        headers: string_map(entry.get("headers")),
        cwd: {
            let cwd = string_field(entry.get("cwd"));
            (!cwd.is_empty()).then_some(cwd)
        },
        timeout_ms: entry.get("timeout").and_then(Value::as_u64),
        origin: origin.to_string(),
    })
}

/// 解析 Codex `config.toml` 的 `[mcp_servers.*]` 段。
pub(crate) fn parse_codex_toml(
    text: &str,
    servers: &mut Vec<SystemExternalMcpServerEntry>,
    errors: &mut Vec<String>,
) {
    let root: toml::Value = match toml::from_str(text) {
        Ok(value) => value,
        Err(err) => {
            errors.push(format!("Failed to parse ~/.codex/config.toml: {err}"));
            return;
        }
    };
    let Some(map) = root.get("mcp_servers").and_then(toml::Value::as_table) else {
        return;
    };
    for (name, entry) in map {
        match toml_entry_to_server(name, entry) {
            Ok(server) => servers.push(server),
            Err(err) => errors.push(err),
        }
    }
}

fn toml_entry_to_server(
    name: &str,
    entry: &toml::Value,
) -> Result<SystemExternalMcpServerEntry, String> {
    let entry = entry
        .as_table()
        .ok_or_else(|| format!("MCP server \"{name}\" is not a table"))?;
    let command = toml_string(entry.get("command"));
    let url = toml_string(entry.get("url"));
    let declared_type = toml_string(entry.get("type")).to_lowercase();

    let transport = match declared_type.as_str() {
        TRANSPORT_HTTP | "streamable-http" | "streamable_http" => TRANSPORT_HTTP,
        TRANSPORT_SSE => TRANSPORT_SSE,
        TRANSPORT_STDIO => TRANSPORT_STDIO,
        "" if !command.is_empty() => TRANSPORT_STDIO,
        "" if !url.is_empty() => TRANSPORT_HTTP,
        other => {
            return Err(format!(
                "MCP server \"{name}\" has unsupported type \"{other}\""
            ))
        }
    };
    if transport == TRANSPORT_STDIO && command.is_empty() {
        return Err(format!("MCP server \"{name}\" is missing command"));
    }
    if transport != TRANSPORT_STDIO && url.is_empty() {
        return Err(format!("MCP server \"{name}\" is missing url"));
    }

    let mut headers = BTreeMap::new();
    if let Some(table) = entry.get("http_headers").and_then(toml::Value::as_table) {
        for (key, value) in table {
            headers.insert(key.clone(), toml_string(Some(value)));
        }
    }

    let mut env = BTreeMap::new();
    if let Some(table) = entry.get("env").and_then(toml::Value::as_table) {
        for (key, value) in table {
            env.insert(key.clone(), toml_string(Some(value)));
        }
    }

    Ok(SystemExternalMcpServerEntry {
        id: name.to_string(),
        transport: transport.to_string(),
        command,
        args: entry
            .get("args")
            .and_then(toml::Value::as_array)
            .map(|items| items.iter().map(|item| toml_string(Some(item))).collect())
            .unwrap_or_default(),
        url,
        env,
        headers,
        cwd: {
            let cwd = toml_string(entry.get("cwd"));
            (!cwd.is_empty()).then_some(cwd)
        },
        timeout_ms: entry
            .get("startup_timeout_ms")
            .and_then(toml::Value::as_integer)
            .and_then(|value| u64::try_from(value).ok()),
        origin: "user".to_string(),
    })
}

fn string_field(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string()
}

fn string_list(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn string_map(value: Option<&Value>) -> BTreeMap<String, String> {
    value
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .filter_map(|(key, value)| {
                    value.as_str().map(|value| (key.clone(), value.to_string()))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn toml_string(value: Option<&toml::Value>) -> String {
    value
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_claude_json_stdio_and_http_entries() {
        let root: Value = serde_json::from_str(
            r#"{
                "mcpServers": {
                    "files": { "command": "npx", "args": ["-y", "server-files"], "env": { "HOME": "/tmp" } },
                    "search": { "type": "http", "url": "https://mcp.example.com/v1", "headers": { "Authorization": "Bearer x" } },
                    "legacy": { "type": "sse", "url": "https://sse.example.com" },
                    "broken": { "args": ["no-command"] }
                }
            }"#,
        )
        .unwrap();
        let mut servers = Vec::new();
        let mut errors = Vec::new();
        collect_json_server_map(root.get("mcpServers"), "user", &mut servers, &mut errors);

        assert_eq!(servers.len(), 3);
        let files = servers.iter().find(|s| s.id == "files").unwrap();
        assert_eq!(files.transport, "stdio");
        assert_eq!(files.command, "npx");
        assert_eq!(files.args, vec!["-y", "server-files"]);
        assert_eq!(files.env.get("HOME").map(String::as_str), Some("/tmp"));

        let search = servers.iter().find(|s| s.id == "search").unwrap();
        assert_eq!(search.transport, "http");
        assert_eq!(search.url, "https://mcp.example.com/v1");
        assert_eq!(
            search.headers.get("Authorization").map(String::as_str),
            Some("Bearer x")
        );

        let legacy = servers.iter().find(|s| s.id == "legacy").unwrap();
        assert_eq!(legacy.transport, "sse");

        assert_eq!(errors.len(), 1);
        assert!(errors[0].contains("broken"));
    }

    #[test]
    fn parses_codex_toml_entries() {
        let text = r#"
model_provider = "custom"

[mcp_servers.desktop-commander]
type = "stdio"
command = "cmd"
args = ["/c", "npx", "-y", "@wonderwhy-er/desktop-commander@latest"]
startup_timeout_ms = 20000

[mcp_servers.desktop-commander.env]
SystemRoot = 'C:\Windows'

[mcp_servers.remote]
url = "https://mcp.example.com"
"#;
        let mut servers = Vec::new();
        let mut errors = Vec::new();
        parse_codex_toml(text, &mut servers, &mut errors);

        assert!(errors.is_empty(), "unexpected errors: {errors:?}");
        assert_eq!(servers.len(), 2);
        let commander = servers.iter().find(|s| s.id == "desktop-commander").unwrap();
        assert_eq!(commander.transport, "stdio");
        assert_eq!(commander.command, "cmd");
        assert_eq!(commander.timeout_ms, Some(20_000));
        assert_eq!(
            commander.env.get("SystemRoot").map(String::as_str),
            Some("C:\\Windows")
        );
        let remote = servers.iter().find(|s| s.id == "remote").unwrap();
        assert_eq!(remote.transport, "http");
    }

    #[test]
    fn dedupes_by_id_keeping_first_scope() {
        let user: Value = serde_json::from_str(
            r#"{ "a": { "command": "user-a" }, "b": { "command": "user-b" } }"#,
        )
        .unwrap();
        let project: Value =
            serde_json::from_str(r#"{ "a": { "command": "project-a" } }"#).unwrap();
        let mut servers = Vec::new();
        let mut errors = Vec::new();
        collect_json_server_map(Some(&user), "user", &mut servers, &mut errors);
        collect_json_server_map(Some(&project), "E:/proj", &mut servers, &mut errors);

        let scan = finish_scan("claude-code", vec!["~/.claude.json".into()], "", servers, errors);
        assert_eq!(scan.servers.len(), 2);
        let a = scan.servers.iter().find(|s| s.id == "a").unwrap();
        assert_eq!(a.command, "user-a");
        assert_eq!(a.origin, "user");
    }
}
