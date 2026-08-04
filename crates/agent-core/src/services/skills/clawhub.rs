//! ClawHub 注册表集成：搜索、卡片归一化、下载 URL 与安装。

use serde_json::Value;
use std::path::Path;
use std::time::Duration;

use super::*;

const CLAWHUB_API_BASE: &str = "https://clawhub.ai";
const DEFAULT_CLAWHUB_SEARCH_LIMIT: usize = 10;
const MAX_CLAWHUB_SEARCH_LIMIT: usize = 20;

pub(crate) fn normalize_clawhub_limit(value: Option<usize>) -> usize {
    value
        .unwrap_or(DEFAULT_CLAWHUB_SEARCH_LIMIT)
        .clamp(1, MAX_CLAWHUB_SEARCH_LIMIT)
}

pub(crate) fn normalize_clawhub_sort(value: Option<&str>) -> Result<&'static str, String> {
    match value.unwrap_or("downloads") {
        "downloads" => Ok("downloads"),
        "stars" => Ok("stars"),
        "installs" => Ok("installs"),
        "updated" => Ok("updated"),
        "newest" => Ok("newest"),
        other => Err(format!("Unsupported ClawHub sort: {other}")),
    }
}

pub(crate) fn json_object(value: &Value) -> Option<&serde_json::Map<String, Value>> {
    value.as_object()
}

pub(crate) fn json_string(item: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
    item.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

pub(crate) fn json_optional_u64(item: &serde_json::Map<String, Value>, key: &str) -> Option<u64> {
    item.get(key).and_then(|value| match value {
        Value::Number(number) => number
            .as_u64()
            .or_else(|| number.as_i64().and_then(|value| u64::try_from(value).ok())),
        _ => None,
    })
}

pub(crate) fn clawhub_download_url_for_slug(
    slug: &str,
    owner_handle: Option<&str>,
    tag: Option<&str>,
) -> Result<String, String> {
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
    // ClawHub 对重名 slug 返回 409，必须带 ownerHandle 消歧。
    if let Some(owner) = owner_handle
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        url.query_pairs_mut().append_pair("ownerHandle", owner);
    }
    Ok(url.into())
}

pub(crate) fn normalize_clawhub_skill_card(raw: &Value) -> Option<SystemClawHubSkillCard> {
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
    let download_url = clawhub_download_url_for_slug(&slug, owner_handle.as_deref(), None).ok()?;
    let web_url = owner_handle
        .as_ref()
        .map(|owner| format!("{CLAWHUB_API_BASE}/{owner}/{slug}"));

    Some(SystemClawHubSkillCard {
        slug: slug.clone(),
        display_name: json_string(item, "displayName").unwrap_or(slug),
        summary: json_string(item, "summary").unwrap_or_default(),
        latest_version,
        downloads: json_optional_u64(item, "downloads")
            .or_else(|| stats.and_then(|value| json_optional_u64(value, "downloads")))
            .unwrap_or(0),
        stars: json_optional_u64(item, "stars")
            .or_else(|| stats.and_then(|value| json_optional_u64(value, "stars")))
            .unwrap_or(0),
        installs_current: json_optional_u64(item, "installsCurrent")
            .or_else(|| json_optional_u64(item, "installs"))
            .or_else(|| stats.and_then(|value| json_optional_u64(value, "installsCurrent")))
            .or_else(|| stats.and_then(|value| json_optional_u64(value, "installs")))
            .unwrap_or(0),
        updated_at: json_optional_u64(item, "updatedAt"),
        owner_handle,
        web_url,
        download_url,
    })
}

pub(crate) fn fetch_clawhub_json(path: &str, params: &[(&str, String)]) -> Result<Value, String> {
    let mut url = reqwest::Url::parse(CLAWHUB_API_BASE)
        .and_then(|base| base.join(path))
        .map_err(|e| format!("Failed to build ClawHub request URL: {e}"))?;
    {
        let mut pairs = url.query_pairs_mut();
        for (key, value) in params {
            pairs.append_pair(key, value);
        }
    }

    let client = crate::services::system_proxy::blocking_client_builder()
        .map_err(|e| format!("Failed to create ClawHub HTTP client: {e}"))?
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

pub(crate) fn clawhub_results_from_field(json: &Value, key: &str) -> Vec<SystemClawHubSkillCard> {
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

pub(crate) fn search_clawhub_skills_from_payload(
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

pub(crate) fn install_clawhub_skill_from_payload(
    root: &Path,
    payload: &serde_json::Map<String, Value>,
) -> Result<(Vec<SystemSkillInstallResult>, String, String), String> {
    let slug = object_string(payload, "slug")
        .ok_or_else(|| "SkillsManager clawhub_install requires slug".to_string())?
        .to_string();
    let owner_handle =
        object_string(payload, "ownerHandle").or_else(|| object_string(payload, "owner"));
    let version = object_string(payload, "version");
    let download_url = clawhub_download_url_for_slug(&slug, owner_handle, version)?;
    let mut install_payload = payload.clone();
    install_payload.insert("action".to_string(), Value::String("install".to_string()));
    install_payload.insert("source".to_string(), Value::String(download_url.clone()));
    install_payload.insert("slug".to_string(), Value::String(slug.clone()));

    let installed = install_source_from_payload(root, &install_payload)?;
    Ok((installed, slug, download_url))
}
