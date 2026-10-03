//! MCP 协议代际兼容的纯逻辑（与传输无关）。
//!
//! - **modern**（2026-07-28 起）：没有 `initialize` 握手，每个请求在
//!   `params._meta` 携带协议版本 / 客户端身份 / 客户端能力；Streamable HTTP
//!   还要把版本、方法名等镜像到请求头。
//! - **legacy**（2025-11-25 及更早）：`initialize` 握手建立会话。
//!
//! 探测与回退的流程在 `mcp.rs` 的 `McpClient` 里，这里只放版本表、`_meta`
//! 注入、modern 错误识别与 HTTP 请求元数据头的构造/校验。

use base64::Engine as _;
use serde_json::{json, Map, Value};

/// 支持的 modern 版本，按偏好排序。
pub(super) const MODERN_PROTOCOL_VERSIONS: &[&str] = &["2026-07-28"];
/// 支持的 legacy 版本，按偏好排序（initialize 依次尝试）。
pub(super) const LEGACY_PROTOCOL_VERSIONS: &[&str] = &[
    "2025-11-25",
    "2025-06-18",
    "2025-03-26",
    "2024-11-05",
    "2024-10-07",
];

pub(super) const META_PROTOCOL_VERSION: &str = "io.modelcontextprotocol/protocolVersion";
const META_CLIENT_INFO: &str = "io.modelcontextprotocol/clientInfo";
const META_CLIENT_CAPABILITIES: &str = "io.modelcontextprotocol/clientCapabilities";

pub(super) const ERR_HEADER_MISMATCH: i64 = -32020;
pub(super) const ERR_MISSING_REQUIRED_CLIENT_CAPABILITY: i64 = -32021;
pub(super) const ERR_UNSUPPORTED_PROTOCOL_VERSION: i64 = -32022;

/// 「已识别的 modern 错误」：收到它说明对端是 modern server，不能回退 initialize。
pub(super) fn is_modern_error_code(code: i64) -> bool {
    matches!(
        code,
        ERR_HEADER_MISMATCH
            | ERR_MISSING_REQUIRED_CLIENT_CAPABILITY
            | ERR_UNSUPPORTED_PROTOCOL_VERSION
    )
}

/// 给请求参数注入 modern `_meta`（保留调用方已有的 `_meta` 键）。
pub(super) fn with_modern_meta(params: Value, version: &str, client_version: &str) -> Value {
    let mut obj = match params {
        Value::Object(map) => map,
        Value::Null => Map::new(),
        other => return other,
    };
    let meta = obj
        .entry("_meta")
        .or_insert_with(|| Value::Object(Map::new()));
    if !meta.is_object() {
        *meta = Value::Object(Map::new());
    }
    if let Value::Object(meta) = meta {
        meta.insert(META_PROTOCOL_VERSION.to_string(), json!(version));
        meta.insert(
            META_CLIENT_INFO.to_string(),
            json!({ "name": "LiveAgent", "version": client_version }),
        );
        meta.insert(META_CLIENT_CAPABILITIES.to_string(), json!({}));
    }
    Value::Object(obj)
}

/// 请求参数里声明的 modern 协议版本；None 表示这是 legacy 请求。
pub(super) fn modern_version_of(params: &Value) -> Option<&str> {
    params
        .get("_meta")
        .and_then(|m| m.get(META_PROTOCOL_VERSION))
        .and_then(|v| v.as_str())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum VersionChoice {
    Modern(String),
    /// 对端只列出了我们支持的 legacy 版本：走 initialize。
    Legacy,
    None,
}

pub(super) fn choose_version(supported: &[String]) -> VersionChoice {
    let has = |v: &str| supported.iter().any(|s| s == v);
    if let Some(v) = MODERN_PROTOCOL_VERSIONS.iter().find(|v| has(v)) {
        return VersionChoice::Modern((*v).to_string());
    }
    if LEGACY_PROTOCOL_VERSIONS.iter().any(|v| has(v)) {
        return VersionChoice::Legacy;
    }
    VersionChoice::None
}

fn string_list(v: Option<&Value>) -> Vec<String> {
    v.and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|s| s.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// `DiscoverResult.supportedVersions`
pub(super) fn discover_supported_versions(result: &Value) -> Vec<String> {
    string_list(result.get("supportedVersions"))
}

/// `UnsupportedProtocolVersionError.data.supported`
pub(super) fn error_supported_versions(data: Option<&Value>) -> Vec<String> {
    string_list(data.and_then(|d| d.get("supported")))
}

/// modern 结果带 `resultType`；legacy 省略视为 `complete`。`input_required`
/// （多轮请求，用于 elicitation/sampling 等）当前不支持，明确报错。
pub(super) fn ensure_complete_result(method: &str, result: &Value) -> Result<(), String> {
    match result.get("resultType").and_then(|v| v.as_str()) {
        None | Some("complete") => Ok(()),
        Some("input_required") => Err(format!(
            "MCP server requested additional client input (resultType=input_required) for {method}; LiveAgent does not support multi round-trip requests yet"
        )),
        Some(other) => Err(format!(
            "MCP server returned an unknown resultType for {method}: {other}"
        )),
    }
}

/// Streamable HTTP 头值编码：不能安全表示为纯 ASCII 头值的，用
/// `=?base64?…?=` 哨兵格式；恰好长得像哨兵的明文也要编码以免歧义。
pub(super) fn encode_header_value(value: &str) -> String {
    let plain_ascii = value
        .bytes()
        .all(|b| b == b'\t' || (0x20..=0x7e).contains(&b));
    let trimmed = value.trim_matches([' ', '\t']) == value;
    let looks_like_sentinel = value.starts_with("=?base64?") && value.ends_with("?=");
    if plain_ascii && trimmed && !looks_like_sentinel {
        value.to_string()
    } else {
        format!(
            "=?base64?{}?=",
            base64::engine::general_purpose::STANDARD.encode(value.as_bytes())
        )
    }
}

/// modern Streamable HTTP 必带的 `Mcp-Method` / `Mcp-Name`。
pub(super) fn standard_request_headers(method: &str, params: &Value) -> Vec<(String, String)> {
    let mut out = vec![("Mcp-Method".to_string(), method.to_string())];
    let name_field = match method {
        "tools/call" | "prompts/get" => Some("name"),
        "resources/read" => Some("uri"),
        _ => None,
    };
    if let Some(name) = name_field
        .and_then(|field| params.get(field))
        .and_then(|v| v.as_str())
    {
        out.push(("Mcp-Name".to_string(), encode_header_value(name)));
    }
    out
}

/// 工具 `inputSchema` 里 `x-mcp-header` 标注的参数：值要镜像到
/// `Mcp-Param-{name}` 头。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ParamHeader {
    pub name: String,
    pub path: Vec<String>,
}

fn is_tchar(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b)
}

/// 解析并校验 `x-mcp-header` 标注；违反约束的工具定义按规范必须拒收（Err）。
pub(super) fn param_headers_from_schema(schema: &Value) -> Result<Vec<ParamHeader>, String> {
    let mut out = Vec::new();
    collect_param_headers(schema, Some(&mut Vec::new()), &mut out)?;
    Ok(out)
}

/// `path` 为 Some 表示当前节点从根仅经 `properties` 链静态可达。
fn collect_param_headers(
    node: &Value,
    path: Option<&mut Vec<String>>,
    out: &mut Vec<ParamHeader>,
) -> Result<(), String> {
    match node {
        Value::Object(obj) => {
            let mut path = path;
            if let Some(header) = obj.get("x-mcp-header") {
                let name = header.as_str().ok_or("x-mcp-header must be a string")?;
                let prop_path = match path.as_deref() {
                    Some(p) if !p.is_empty() => p.clone(),
                    _ => {
                        return Err(format!(
                            "x-mcp-header `{name}` is not on a statically reachable property"
                        ))
                    }
                };
                if name.is_empty() || !name.bytes().all(is_tchar) {
                    return Err(format!("x-mcp-header `{name}` is not a valid header token"));
                }
                if out.iter().any(|h| h.name.eq_ignore_ascii_case(name)) {
                    return Err(format!("x-mcp-header `{name}` is not unique"));
                }
                let ty = obj.get("type").and_then(|v| v.as_str());
                if !matches!(ty, Some("string" | "integer" | "boolean")) {
                    return Err(format!(
                        "x-mcp-header `{name}` must annotate a string/integer/boolean parameter"
                    ));
                }
                out.push(ParamHeader {
                    name: name.to_string(),
                    path: prop_path,
                });
            }
            for (key, child) in obj {
                if key == "x-mcp-header" {
                    continue;
                }
                if key == "properties" {
                    if let Value::Object(props) = child {
                        for (prop, schema) in props {
                            match path.as_deref_mut() {
                                Some(p) => {
                                    p.push(prop.clone());
                                    let res = collect_param_headers(schema, Some(p), out);
                                    p.pop();
                                    res?;
                                }
                                None => collect_param_headers(schema, None, out)?,
                            }
                        }
                        continue;
                    }
                }
                collect_param_headers(child, None, out)?;
            }
            Ok(())
        }
        Value::Array(items) => {
            for item in items {
                collect_param_headers(item, None, out)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

const MAX_SAFE_INTEGER: i64 = (1 << 53) - 1;

/// 按标注从调用参数取值并编码成 `Mcp-Param-*` 头；路径上没有值则省略。
pub(super) fn param_header_values(
    headers: &[ParamHeader],
    arguments: &Value,
) -> Vec<(String, String)> {
    headers
        .iter()
        .filter_map(|h| {
            let value = h.path.iter().try_fold(arguments, |cur, key| cur.get(key))?;
            let text = match value {
                Value::String(s) => s.clone(),
                Value::Bool(b) => b.to_string(),
                Value::Number(n) => {
                    let i = n.as_i64()?;
                    if !(-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&i) {
                        return None;
                    }
                    i.to_string()
                }
                _ => return None,
            };
            Some((format!("Mcp-Param-{}", h.name), encode_header_value(&text)))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modern_meta_is_injected_and_preserves_existing_keys() {
        let params = json!({ "name": "t", "_meta": { "progressToken": 1 } });
        let out = with_modern_meta(params, "2026-07-28", "1.0.0");
        assert_eq!(modern_version_of(&out), Some("2026-07-28"));
        assert_eq!(out["_meta"]["progressToken"], json!(1));
        assert_eq!(
            out["_meta"]["io.modelcontextprotocol/clientInfo"]["name"],
            json!("LiveAgent")
        );
        assert_eq!(
            out["_meta"]["io.modelcontextprotocol/clientCapabilities"],
            json!({})
        );
        assert_eq!(out["name"], json!("t"));

        let empty = with_modern_meta(Value::Null, "2026-07-28", "1.0.0");
        assert_eq!(modern_version_of(&empty), Some("2026-07-28"));
        assert_eq!(modern_version_of(&json!({})), None);
    }

    #[test]
    fn choose_version_prefers_modern_then_legacy() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert_eq!(
            choose_version(&s(&["2025-11-25", "2026-07-28"])),
            VersionChoice::Modern("2026-07-28".into())
        );
        assert_eq!(choose_version(&s(&["2025-06-18"])), VersionChoice::Legacy);
        assert_eq!(choose_version(&s(&["2099-01-01"])), VersionChoice::None);
        assert_eq!(
            error_supported_versions(Some(&json!({ "supported": ["2026-07-28"] }))),
            s(&["2026-07-28"])
        );
    }

    #[test]
    fn modern_error_codes_are_recognized() {
        assert!(is_modern_error_code(-32022));
        assert!(is_modern_error_code(-32020));
        assert!(!is_modern_error_code(-32601));
        assert!(!is_modern_error_code(-32000));
    }

    #[test]
    fn result_type_input_required_is_rejected() {
        assert!(ensure_complete_result("tools/call", &json!({})).is_ok());
        assert!(ensure_complete_result("tools/call", &json!({"resultType":"complete"})).is_ok());
        assert!(
            ensure_complete_result("tools/call", &json!({"resultType":"input_required"})).is_err()
        );
    }

    #[test]
    fn header_values_use_base64_sentinel_when_unsafe() {
        assert_eq!(encode_header_value("us-west1"), "us-west1");
        assert_eq!(
            encode_header_value("Hello, 世界"),
            "=?base64?SGVsbG8sIOS4lueVjA==?="
        );
        assert_eq!(encode_header_value(" padded "), "=?base64?IHBhZGRlZCA=?=");
        assert_eq!(
            encode_header_value("line1\nline2"),
            "=?base64?bGluZTEKbGluZTI=?="
        );
        assert_eq!(
            encode_header_value("=?base64?literal?="),
            "=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?="
        );
    }

    #[test]
    fn standard_headers_carry_method_and_name() {
        let h = standard_request_headers("tools/call", &json!({ "name": "get_weather" }));
        assert_eq!(
            h,
            vec![
                ("Mcp-Method".to_string(), "tools/call".to_string()),
                ("Mcp-Name".to_string(), "get_weather".to_string())
            ]
        );
        let h = standard_request_headers("resources/read", &json!({ "uri": "file:///a b" }));
        assert_eq!(h[1].1, "file:///a b");
        assert_eq!(standard_request_headers("tools/list", &json!({})).len(), 1);
    }

    #[test]
    fn param_headers_are_collected_from_reachable_properties() {
        let schema = json!({
            "type": "object",
            "properties": {
                "region": { "type": "string", "x-mcp-header": "Region" },
                "opts": {
                    "type": "object",
                    "properties": { "dry": { "type": "boolean", "x-mcp-header": "Dry" } }
                },
                "query": { "type": "string" }
            }
        });
        let headers = param_headers_from_schema(&schema).unwrap();
        assert_eq!(headers.len(), 2);
        let values = param_header_values(
            &headers,
            &json!({ "region": "us-west1", "opts": { "dry": true }, "query": "x" }),
        );
        assert!(values.contains(&("Mcp-Param-Region".to_string(), "us-west1".to_string())));
        assert!(values.contains(&("Mcp-Param-Dry".to_string(), "true".to_string())));
        // 缺省的参数不发头
        assert!(param_header_values(&headers, &json!({})).is_empty());
    }

    #[test]
    fn invalid_param_header_annotations_are_rejected() {
        let in_array = json!({
            "type": "object",
            "properties": {
                "list": { "type": "array", "items": { "type": "string", "x-mcp-header": "Item" } }
            }
        });
        assert!(param_headers_from_schema(&in_array).is_err());

        let number = json!({
            "type": "object",
            "properties": { "n": { "type": "number", "x-mcp-header": "N" } }
        });
        assert!(param_headers_from_schema(&number).is_err());

        let dup = json!({
            "type": "object",
            "properties": {
                "a": { "type": "string", "x-mcp-header": "Dup" },
                "b": { "type": "string", "x-mcp-header": "dup" }
            }
        });
        assert!(param_headers_from_schema(&dup).is_err());

        let bad_token = json!({
            "type": "object",
            "properties": { "a": { "type": "string", "x-mcp-header": "Bad Name" } }
        });
        assert!(param_headers_from_schema(&bad_token).is_err());

        let in_any_of = json!({
            "type": "object",
            "anyOf": [ { "properties": { "a": { "type": "string", "x-mcp-header": "A" } } } ]
        });
        assert!(param_headers_from_schema(&in_any_of).is_err());
    }
}
