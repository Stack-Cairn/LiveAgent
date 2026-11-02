//! `/v1/health` 契约解析。规则见 docs/design/2026-10-26-kbrain-decoupled-updates.md
//! 第 3.1 节，与 TS、Go 解析器共用 `agent-ui/src/lib/kbrain/health-contract-vectors.json`。

use serde_json::{Map, Value};

pub const LEGACY_PROTOCOL_VERSION: &str = "kbrain.agent.v1";
const PROTOCOL_NAME: &str = "kbrain.agent";
const PROTOCOL_MAJOR: u64 = 1;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KBrainHealth {
    /// 后端没有 `protocol` 字段，按结构化 health 之前的旧后端处理。
    pub legacy: bool,
    pub protocol_minor: u64,
    pub build_version: Option<String>,
    pub instance_id: Option<String>,
    pub capability_revision: Option<u64>,
}

/// 2^53-1：TS 在 JSON.parse 之后分不出 1 与 1.0，三端都按数值判断整数并限制在这个范围内。
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

fn safe_uint(value: &Value) -> Option<u64> {
    let number = value.as_f64()?;
    (number.is_finite() && number.trunc() == number && (0.0..=MAX_SAFE_INTEGER).contains(&number))
        .then_some(number as u64)
}

fn violation(message: impl AsRef<str>) -> String {
    format!("K-brain health contract violation: {}", message.as_ref())
}

/// 字段存在但类型错误属于契约损坏，不能当作缺失。
fn optional<'a, T>(
    body: &'a Map<String, Value>,
    key: &str,
    read: impl FnOnce(&'a Value) -> Option<T>,
    expected: &str,
) -> Result<Option<T>, String> {
    match body.get(key) {
        None => Ok(None),
        Some(value) => read(value)
            .map(Some)
            .ok_or_else(|| violation(format!("{key} must be {expected}"))),
    }
}

/// 只有完全缺失 `protocol` 才走旧 v1 兜底；null、字符串或名称/主版本矛盾一律拒绝。
fn read_protocol(body: &Map<String, Value>) -> Result<Option<u64>, String> {
    let Some(protocol) = body.get("protocol") else {
        return Ok(None);
    };
    let protocol = protocol
        .as_object()
        .ok_or_else(|| violation("protocol must be an object"))?;
    let name = protocol.get("name").and_then(Value::as_str);
    let major = protocol.get("major").and_then(safe_uint);
    if name != Some(PROTOCOL_NAME) || major != Some(PROTOCOL_MAJOR) {
        return Err(violation(format!(
            "protocol {}/{} contradicts {LEGACY_PROTOCOL_VERSION}",
            protocol.get("name").unwrap_or(&Value::Null),
            protocol.get("major").unwrap_or(&Value::Null)
        )));
    }
    protocol
        .get("minor")
        .and_then(safe_uint)
        .map(Some)
        .ok_or_else(|| violation("protocol.minor must be a non-negative integer"))
}

fn read_build(body: &Map<String, Value>) -> Result<Option<String>, String> {
    let Some(build) = optional(body, "build", Value::as_object, "an object")? else {
        return Ok(None);
    };
    let version = build
        .get("version")
        .and_then(Value::as_str)
        .filter(|version| !version.trim().is_empty())
        .ok_or_else(|| violation("build.version must be a string"))?;
    optional(build, "revision", Value::as_str, "a string")?;
    optional(build, "channel", Value::as_str, "a string")?;
    Ok(Some(version.to_string()))
}

pub fn parse_health(body: &Value) -> Result<KBrainHealth, String> {
    let body = body
        .as_object()
        .ok_or_else(|| violation("health body must be a JSON object"))?;
    if body.get("status").and_then(Value::as_str) != Some("ok") {
        return Err(violation(format!(
            "status is {}, not \"ok\"",
            body.get("status").unwrap_or(&Value::Null)
        )));
    }
    let version = body.get("version");
    if version.and_then(Value::as_str) != Some(LEGACY_PROTOCOL_VERSION) {
        let reported = match version {
            Some(Value::String(text)) => text.clone(),
            Some(other) => other.to_string(),
            None => "undefined".into(),
        };
        return Err(format!(
            "K-brain backend protocol mismatch (reported version {reported})"
        ));
    }
    let protocol_minor = read_protocol(body)?;
    let build_version = read_build(body)?;
    optional(body, "startupContract", safe_uint, "a non-negative integer")?;
    let instance_id = optional(body, "instanceId", Value::as_str, "a string")?.map(str::to_string);
    let capability_revision = optional(
        body,
        "capabilityRevision",
        safe_uint,
        "a non-negative integer",
    )?;
    optional(body, "capabilities", Value::as_object, "an object")?;
    Ok(KBrainHealth {
        legacy: protocol_minor.is_none(),
        protocol_minor: protocol_minor.unwrap_or(0),
        build_version,
        instance_id,
        capability_revision,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const VECTORS: &str =
        include_str!("../../../../agent-ui/src/lib/kbrain/health-contract-vectors.json");

    #[test]
    fn shared_vectors_accept_and_reject_like_other_hosts() {
        let vectors: Value = serde_json::from_str(VECTORS).expect("vectors parse");
        for vector in vectors["accept"].as_array().expect("accept list") {
            let name = vector["name"].as_str().unwrap_or_default();
            let parsed = parse_health(&vector["body"])
                .unwrap_or_else(|error| panic!("{name} should be accepted: {error}"));
            assert_eq!(parsed.legacy, vector["legacy"].as_bool().unwrap(), "{name}");
            assert_eq!(
                parsed.protocol_minor,
                vector["minor"].as_u64().unwrap(),
                "{name}"
            );
            if let Some(expected) = vector["buildVersion"].as_str() {
                assert_eq!(parsed.build_version.as_deref(), Some(expected), "{name}");
            }
            if let Some(expected) = vector["instanceId"].as_str() {
                assert_eq!(parsed.instance_id.as_deref(), Some(expected), "{name}");
            }
            if let Some(expected) = vector["capabilityRevision"].as_u64() {
                assert_eq!(parsed.capability_revision, Some(expected), "{name}");
            }
        }
        for vector in vectors["reject"].as_array().expect("reject list") {
            let name = vector["name"].as_str().unwrap_or_default();
            assert!(
                parse_health(&vector["body"]).is_err(),
                "{name} should be rejected"
            );
        }
    }

    #[test]
    fn version_mismatch_keeps_established_wording() {
        let error = parse_health(&serde_json::json!({"status": "ok", "version": "wrong"}))
            .expect_err("mismatch");
        assert_eq!(
            error,
            "K-brain backend protocol mismatch (reported version wrong)"
        );
    }
}
