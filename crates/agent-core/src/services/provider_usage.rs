use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use futures_util::StreamExt;
use reqwest::{Method, Url};
use rquickjs::{Context, Function, Runtime};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::commands::settings::{load_providers, open_db};

const MAX_SCRIPT_BYTES: usize = 64 * 1024;
const MAX_SCRIPT_VARIABLE_BYTES: usize = 16 * 1024;
const MAX_SCRIPT_OUTPUT_BYTES: usize = 64 * 1024;
const MAX_REQUEST_BODY_BYTES: usize = 64 * 1024;
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const MAX_HEADERS: usize = 64;
const MAX_HEADER_BYTES: usize = 16 * 1024;
const MAX_ENTRIES: usize = 16;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const SCRIPT_TIMEOUT: Duration = Duration::from_millis(100);
const DEFAULT_REQUEST_TIMEOUT_SECS: u64 = 10;
const MIN_REQUEST_TIMEOUT_SECS: u64 = 2;
const MAX_REQUEST_TIMEOUT_SECS: u64 = 30;

// KEEP IN SYNC:内置预设脚本与两端 providerUtils.ts 的 USAGE_QUERY_PRESET_SCRIPTS
// 逐字符一致(前端选模板时填充可编辑副本;脚本为空的存量配置由这里兜底执行)。
// 内容一比一复刻 cc-switch UsageScriptModal 的 GENERAL/NEW_API 模板,仅
// User-Agent 品牌与 NewAPI 文案默认值(套餐名/失败消息须 locale 无关)不同。
const GENERAL_SCRIPT: &str = r#"({
  request: {
    url: "{{baseUrl}}/user/balance",
    method: "GET",
    headers: {
      "Authorization": "Bearer {{apiKey}}",
      "User-Agent": "LiveAgent/1.0"
    }
  },
  extractor: function(response) {
    return {
      isValid: response.is_active || true,
      remaining: response.balance,
      unit: "USD"
    };
  }
})"#;

const NEWAPI_SCRIPT: &str = r#"({
  request: {
    url: "{{baseUrl}}/api/user/self",
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer {{accessToken}}",
      "User-Agent": "LiveAgent/1.0",
      "New-Api-User": "{{userId}}"
    },
  },
  extractor: function (response) {
    if (response.success && response.data) {
      return {
        planName: response.data.group || "Balance",
        remaining: response.data.quota / 500000,
        used: response.data.used_quota / 500000,
        total: (response.data.quota + response.data.used_quota) / 500000,
        unit: "USD",
      };
    }
    return {
      isValid: false,
      invalidMessage: response.message || "NewAPI usage query failed"
    };
  },
})"#;

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageData {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extra: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_valid: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub invalid_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub used: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remaining: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUsageResult {
    pub data: Vec<UsageData>,
    pub queried_at: Option<i64>,
    pub error: Option<String>,
    pub is_stale: bool,
}

#[derive(Default)]
pub struct ProviderUsageService {
    cache: Mutex<UsageCache>,
}

impl ProviderUsageService {
    pub async fn query(&self, provider_id: &str, force: bool) -> ProviderUsageResult {
        let provider = match load_provider(provider_id) {
            Ok(provider) => provider,
            Err(error) => {
                self.cache().invalidate(provider_id);
                return failed_result(error);
            }
        };
        let prepared = match prepare_query(&provider) {
            Ok(prepared) => prepared,
            Err(error) => {
                self.cache().invalidate(provider_id);
                return failed_result(error);
            }
        };
        let identity = provider_query_identity(&provider);
        if !force {
            if let Some(cached) = self.cache().get(provider_id, &identity).cloned() {
                return cached;
            }
        }

        match execute_prepared_query(&prepared).await {
            Ok(data) if data.is_empty() => {
                // 空结果视为脚本/配置问题(确定性失败),不再展示旧值。
                self.cache().invalidate(provider_id);
                failed_result("Usage query returned no entries".to_string())
            }
            Ok(data) => {
                let result = ProviderUsageResult {
                    data,
                    queried_at: Some(now_millis()),
                    error: None,
                    is_stale: false,
                };
                self.cache()
                    .record_success(provider_id, identity, result.clone());
                result
            }
            // 确定性失败(4xx 鉴权/配置、脚本错误)清掉快照立即透出;瞬时失败
            // (网络/超时/5xx/429)保留上次成功值并标 isStale。
            Err(failure) if failure.deterministic => {
                self.cache().invalidate(provider_id);
                failed_result(failure.message)
            }
            Err(failure) => self
                .cache()
                .record_failure(provider_id, identity, &failure.message),
        }
    }

    /// 「测试查询」:按前端草稿配置执行一次查询——忽略启用开关、不读写缓存、
    /// 不落库。草稿以编辑器当前内容为准;WebUI 草稿的秘密被脱敏为空串,
    /// *Configured=true 表示沿用已存密钥。
    pub async fn test(&self, provider_id: &str, draft_json: &str) -> ProviderUsageResult {
        let provider = match load_provider(provider_id) {
            Ok(provider) => provider,
            Err(error) => return failed_result(error),
        };
        let draft = match serde_json::from_str::<UsageQueryConfig>(draft_json) {
            Ok(draft) => draft,
            Err(_) => return failed_result("Usage query draft is invalid".to_string()),
        };
        execute_draft_test(provider, draft).await
    }

    fn cache(&self) -> std::sync::MutexGuard<'_, UsageCache> {
        self.cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

async fn execute_draft_test(
    mut provider: StoredProvider,
    draft: UsageQueryConfig,
) -> ProviderUsageResult {
    provider.usage_query = merge_draft_config(draft, &provider.usage_query);
    // 测试永远按草稿执行,不受启用开关限制。
    provider.usage_query.enabled = true;
    let prepared = match prepare_query(&provider) {
        Ok(prepared) => prepared,
        Err(error) => return failed_result(error),
    };
    match execute_prepared_query(&prepared).await {
        Ok(data) if data.is_empty() => failed_result("Usage query returned no entries".to_string()),
        Ok(data) => ProviderUsageResult {
            data,
            queried_at: Some(now_millis()),
            error: None,
            is_stale: false,
        },
        Err(failure) => failed_result(failure.message),
    }
}

fn merge_draft_config(
    mut draft: UsageQueryConfig,
    persisted: &UsageQueryConfig,
) -> UsageQueryConfig {
    if draft.api_key.trim().is_empty() && draft.api_key_configured {
        draft.api_key = persisted.api_key.clone();
    }
    if draft.access_token.trim().is_empty() && draft.access_token_configured {
        draft.access_token = persisted.access_token.clone();
    }
    if draft.secret_access_key.trim().is_empty() && draft.secret_access_key_configured {
        draft.secret_access_key = persisted.secret_access_key.clone();
    }
    draft
}

type ProviderQueryIdentity = [u8; 32];

struct CachedUsage {
    identity: ProviderQueryIdentity,
    result: ProviderUsageResult,
}

#[derive(Default)]
struct UsageCache {
    values: HashMap<String, CachedUsage>,
}

impl UsageCache {
    fn get(
        &self,
        provider_id: &str,
        identity: &ProviderQueryIdentity,
    ) -> Option<&ProviderUsageResult> {
        self.values
            .get(provider_id)
            .filter(|cached| &cached.identity == identity && !cached.result.data.is_empty())
            .map(|cached| &cached.result)
    }

    fn record_success(
        &mut self,
        provider_id: &str,
        identity: ProviderQueryIdentity,
        mut result: ProviderUsageResult,
    ) {
        result.error = None;
        result.is_stale = false;
        self.values
            .insert(provider_id.to_string(), CachedUsage { identity, result });
    }

    fn record_failure(
        &mut self,
        provider_id: &str,
        identity: ProviderQueryIdentity,
        error: &str,
    ) -> ProviderUsageResult {
        if let Some(cached) = self
            .values
            .get_mut(provider_id)
            .filter(|cached| cached.identity == identity && !cached.result.data.is_empty())
        {
            cached.result.error = Some(error.to_string());
            cached.result.is_stale = true;
            return cached.result.clone();
        }
        self.invalidate(provider_id);
        failed_result(error.to_string())
    }

    fn invalidate(&mut self, provider_id: &str) {
        self.values.remove(provider_id);
    }
}

fn failed_result(error: String) -> ProviderUsageResult {
    ProviderUsageResult {
        data: Vec::new(),
        queried_at: None,
        error: Some(error),
        is_stale: false,
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredProvider {
    #[serde(rename = "type")]
    provider_type: String,
    base_url: String,
    api_key: String,
    #[serde(default)]
    usage_query: UsageQueryConfig,
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UsageQueryConfig {
    enabled: bool,
    mode: String,
    script: String,
    base_url: String,
    // 查询专用 API Key 覆盖(空则回退供应商自身的 apiKey)。
    #[serde(default)]
    api_key: String,
    access_token: String,
    user_id: String,
    access_key_id: String,
    secret_access_key: String,
    // Token Plan 供应商(空=按 Base URL 自动检测;智谱团队与个人版 base_url
    // 相同,必须靠显式选择路由)。
    #[serde(default)]
    coding_plan_provider: String,
    // 智谱团队套餐:组织/项目 ID(作为 bigmodel-organization / bigmodel-project
    // 请求头,沿用供应商自身 API Key)。
    #[serde(default)]
    team_organization_id: String,
    #[serde(default)]
    team_project_id: String,
    // *Configured 标志仅在「按草稿测试」时使用:WebUI 草稿的秘密被脱敏为空串,
    // true 表示沿用已存密钥;常规查询路径不读。
    #[serde(default)]
    api_key_configured: bool,
    #[serde(default)]
    access_token_configured: bool,
    #[serde(default)]
    secret_access_key_configured: bool,
    // 每供应商请求超时(秒,clamp 2-30,缺省 10)。
    #[serde(default)]
    timeout_secs: Option<f64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum UsageQueryMode {
    CodingPlan,
    Balance,
    General,
    Newapi,
    Custom,
}

fn parse_usage_mode(mode: &str) -> Result<UsageQueryMode, String> {
    match mode {
        "coding-plan" => Ok(UsageQueryMode::CodingPlan),
        "balance" => Ok(UsageQueryMode::Balance),
        "general" => Ok(UsageQueryMode::General),
        "newapi" => Ok(UsageQueryMode::Newapi),
        "custom" => Ok(UsageQueryMode::Custom),
        _ => Err("Unsupported usage query mode".to_string()),
    }
}

/// 脚本类模式的生效脚本:general/newapi 允许用户编辑后的副本,为空时回退
/// 内置预设(护住只选了模板未落脚本的存量配置);custom 必须非空。
fn effective_script(
    mode: UsageQueryMode,
    config: &UsageQueryConfig,
) -> Result<Option<&str>, String> {
    match mode {
        UsageQueryMode::CodingPlan | UsageQueryMode::Balance => Ok(None),
        UsageQueryMode::General | UsageQueryMode::Newapi => {
            let preset = if mode == UsageQueryMode::General {
                GENERAL_SCRIPT
            } else {
                NEWAPI_SCRIPT
            };
            Ok(Some(if config.script.trim().is_empty() {
                preset
            } else {
                config.script.as_str()
            }))
        }
        UsageQueryMode::Custom => {
            if config.script.trim().is_empty() {
                Err("Custom usage script is empty".to_string())
            } else {
                Ok(Some(config.script.as_str()))
            }
        }
    }
}

fn resolve_timeout(config: &UsageQueryConfig) -> Duration {
    let secs = config
        .timeout_secs
        .filter(|secs| secs.is_finite())
        .map(|secs| secs.round() as i64)
        .unwrap_or(DEFAULT_REQUEST_TIMEOUT_SECS as i64);
    Duration::from_secs(secs.clamp(
        MIN_REQUEST_TIMEOUT_SECS as i64,
        MAX_REQUEST_TIMEOUT_SECS as i64,
    ) as u64)
}

fn provider_query_identity(provider: &StoredProvider) -> ProviderQueryIdentity {
    // 缓存 identity 用生效脚本而非原始 script 字段:general/newapi 空脚本走
    // 内置预设,预设升级(应用版本变化)也应正确失效缓存。
    let script_identity = parse_usage_mode(provider.usage_query.mode.as_str())
        .ok()
        .and_then(|mode| effective_script(mode, &provider.usage_query).ok().flatten())
        .unwrap_or(provider.usage_query.script.as_str());
    let mut digest = Sha256::new();
    for value in [
        provider.provider_type.as_str(),
        provider.base_url.as_str(),
        provider.api_key.as_str(),
        provider.usage_query.mode.as_str(),
        script_identity,
        provider.usage_query.base_url.as_str(),
        provider.usage_query.api_key.as_str(),
        provider.usage_query.access_token.as_str(),
        provider.usage_query.user_id.as_str(),
        provider.usage_query.access_key_id.as_str(),
        provider.usage_query.secret_access_key.as_str(),
    ] {
        digest.update((value.len() as u64).to_be_bytes());
        digest.update(value.as_bytes());
    }
    digest.update(
        resolve_timeout(&provider.usage_query)
            .as_secs()
            .to_be_bytes(),
    );
    digest.update([provider.usage_query.enabled as u8]);
    digest.finalize().into()
}

#[derive(Clone, Default)]
struct ScriptVariables {
    api_key: String,
    base_url: String,
    access_token: String,
    user_id: String,
}

#[derive(Clone)]
struct HttpRequest {
    url: Url,
    method: Method,
    headers: HashMap<String, String>,
    body: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ProviderAdapter {
    DeepSeek,
    StepFun,
    StepFunIntl,
    SiliconFlowCn,
    SiliconFlowEn,
    OpenRouter,
    Novita,
    Kimi,
    Zhipu,
    MiniMax,
    ZenMux,
    VolcengineAfp,
    VolcengineCoding,
    Script,
}

#[derive(Clone)]
struct PreparedRequest {
    request: HttpRequest,
    adapter: ProviderAdapter,
    script: Option<(String, ScriptVariables)>,
}

struct PreparedQuery {
    primary: PreparedRequest,
    fallback: Option<PreparedRequest>,
    timeout: Duration,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum QueryFailureKind {
    Auth,
    Soft,
    Transient,
}

#[derive(Debug)]
struct QueryFailure {
    kind: QueryFailureKind,
    // 确定性失败(鉴权/配置/脚本错误)清快照立即透出;瞬时失败(网络、
    // 5xx、429)保留上次成功值标 isStale。与前端展示语义耦合,勿随意改判。
    deterministic: bool,
    message: String,
}

impl QueryFailure {
    fn new(kind: QueryFailureKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            deterministic: !matches!(kind, QueryFailureKind::Transient),
            message: message.into(),
        }
    }

    fn http(status: reqwest::StatusCode, message: impl Into<String>) -> Self {
        Self {
            kind: QueryFailureKind::Soft,
            deterministic: deterministic_http_status(status),
            message: message.into(),
        }
    }
}

// 4xx 通常是鉴权/配置错(确定性),但超时/限流类除外:408/425/429 按瞬时处理。
fn deterministic_http_status(status: reqwest::StatusCode) -> bool {
    status.is_client_error()
        && !matches!(
            status,
            reqwest::StatusCode::REQUEST_TIMEOUT
                | reqwest::StatusCode::TOO_EARLY
                | reqwest::StatusCode::TOO_MANY_REQUESTS
        )
}

#[derive(Debug)]
struct HttpResponse {
    status: reqwest::StatusCode,
    body: Vec<u8>,
}

fn load_provider(provider_id: &str) -> Result<StoredProvider, String> {
    let conn = open_db().map_err(|_| "Unable to open provider settings".to_string())?;
    let providers = load_providers(&conn)
        .map_err(|_| "Unable to load provider settings".to_string())?
        .and_then(|value| value.as_array().cloned())
        .ok_or_else(|| "Provider not found".to_string())?;
    let provider = providers
        .into_iter()
        .find(|provider| provider.get("id").and_then(Value::as_str) == Some(provider_id))
        .ok_or_else(|| "Provider not found".to_string())?;
    serde_json::from_value(provider).map_err(|_| "Provider settings are invalid".to_string())
}

fn prepare_query(provider: &StoredProvider) -> Result<PreparedQuery, String> {
    if !matches!(
        provider.provider_type.as_str(),
        "claude_code" | "codex" | "gemini" | "xai"
    ) {
        return Err("Unsupported provider type".to_string());
    }
    if !provider.usage_query.enabled {
        return Err("Usage query is disabled".to_string());
    }

    let mode = parse_usage_mode(provider.usage_query.mode.as_str())?;
    match mode {
        UsageQueryMode::CodingPlan => prepare_coding_plan_query(provider),
        UsageQueryMode::Balance => prepare_balance_query(provider),
        UsageQueryMode::General | UsageQueryMode::Newapi | UsageQueryMode::Custom => {
            let script = effective_script(mode, &provider.usage_query)?
                .ok_or_else(|| "Usage script is unavailable".to_string())?;
            // custom 之外的脚本模式强制与 Base URL 同源(HTTPS 由同源校验连带保证)。
            prepare_script_query(provider, script, mode != UsageQueryMode::Custom)
        }
    }
}

fn prepare_script_query(
    provider: &StoredProvider,
    script: &str,
    same_origin: bool,
) -> Result<PreparedQuery, String> {
    let base_url = if provider.usage_query.base_url.trim().is_empty() {
        provider.base_url.trim()
    } else {
        provider.usage_query.base_url.trim()
    };
    let api_key = if provider.usage_query.api_key.trim().is_empty() {
        provider.api_key.as_str()
    } else {
        provider.usage_query.api_key.as_str()
    };
    let variables = ScriptVariables {
        api_key: api_key.to_string(),
        base_url: base_url.trim_end_matches('/').to_string(),
        access_token: provider.usage_query.access_token.clone(),
        user_id: provider.usage_query.user_id.clone(),
    };
    let request = evaluate_script_request(script, &variables)?;
    let url = if same_origin {
        validate_standard_destination(request.url.as_str(), base_url)?
    } else {
        validate_destination(request.url.as_str())?
    };
    let request = HttpRequest { url, ..request };
    Ok(PreparedQuery {
        primary: PreparedRequest {
            request,
            adapter: ProviderAdapter::Script,
            script: Some((script.to_string(), variables)),
        },
        fallback: None,
        timeout: resolve_timeout(&provider.usage_query),
    })
}

fn prepare_balance_query(provider: &StoredProvider) -> Result<PreparedQuery, String> {
    if provider.api_key.trim().is_empty() {
        return Err("Provider API key is not configured".to_string());
    }
    let base = validate_destination(&provider.base_url)?;
    if base.scheme() != "https" {
        return Err("Built-in usage adapters require HTTPS".to_string());
    }
    let host = base.host_str().unwrap_or_default().to_ascii_lowercase();
    let (adapter, endpoint) = match host.as_str() {
        "api.deepseek.com" => (
            ProviderAdapter::DeepSeek,
            "https://api.deepseek.com/user/balance",
        ),
        // 国内站(CNY)与国际站(USD)是两套独立账号体系,按 host 直连各自端点。
        "api.stepfun.com" => (
            ProviderAdapter::StepFun,
            "https://api.stepfun.com/v1/accounts",
        ),
        "api.stepfun.ai" => (
            ProviderAdapter::StepFunIntl,
            "https://api.stepfun.ai/v1/accounts",
        ),
        "api.siliconflow.cn" => (
            ProviderAdapter::SiliconFlowCn,
            "https://api.siliconflow.cn/v1/user/info",
        ),
        "api.siliconflow.com" => (
            ProviderAdapter::SiliconFlowEn,
            "https://api.siliconflow.com/v1/user/info",
        ),
        "openrouter.ai" => (
            ProviderAdapter::OpenRouter,
            "https://openrouter.ai/api/v1/credits",
        ),
        "api.novita.ai" => (
            ProviderAdapter::Novita,
            "https://api.novita.ai/v3/user/balance",
        ),
        _ => return Err("No balance adapter matches this provider".to_string()),
    };
    let request = bearer_request(endpoint, &provider.api_key)?;
    Ok(single_request_query(
        request,
        adapter,
        resolve_timeout(&provider.usage_query),
    ))
}

fn prepare_coding_plan_query(provider: &StoredProvider) -> Result<PreparedQuery, String> {
    let timeout = resolve_timeout(&provider.usage_query);
    let plan = provider
        .usage_query
        .coding_plan_provider
        .trim()
        .to_ascii_lowercase();

    // 智谱团队套餐:base_url 与个人版相同无法自动区分,必须显式选择路由。
    // 固定国内站,quota 同路径 + `?type=2` + 组织/项目请求头;响应 shape 与
    // 个人版一致,复用 Zhipu 解析器(对齐 cc-switch query_zhipu_team)。
    if plan == "zhipu_team" {
        let organization = provider.usage_query.team_organization_id.trim();
        let project = provider.usage_query.team_project_id.trim();
        if provider.api_key.trim().is_empty() || organization.is_empty() || project.is_empty() {
            return Err(
                "Zhipu team plan needs the API key + organization ID + project ID".to_string(),
            );
        }
        let mut request = raw_authorization_request(
            "https://open.bigmodel.cn/api/monitor/usage/quota/limit?type=2",
            &provider.api_key,
        )?;
        request.headers.insert(
            "bigmodel-organization".to_string(),
            organization.to_string(),
        );
        request
            .headers
            .insert("bigmodel-project".to_string(), project.to_string());
        request
            .headers
            .insert("Content-Type".to_string(), "application/json".to_string());
        request
            .headers
            .insert("Accept-Language".to_string(), "en-US,en".to_string());
        return Ok(single_request_query(
            request,
            ProviderAdapter::Zhipu,
            timeout,
        ));
    }

    // ZenMux 支持查询专用 baseUrl/apiKey 覆盖(cc-switch 同款);其余供应商
    // 一律用供应商自身凭据与地址。
    let zenmux = plan == "zenmux";
    let base_source = if zenmux && !provider.usage_query.base_url.trim().is_empty() {
        provider.usage_query.base_url.trim()
    } else {
        provider.base_url.as_str()
    };
    let api_key = if zenmux && !provider.usage_query.api_key.trim().is_empty() {
        provider.usage_query.api_key.as_str()
    } else {
        provider.api_key.as_str()
    };

    let base = validate_destination(base_source)?;
    if base.scheme() != "https" {
        return Err("Built-in usage adapters require HTTPS".to_string());
    }
    let host = base.host_str().unwrap_or_default().to_ascii_lowercase();
    if host.ends_with(".volces.com") && base.path().contains("/api/coding") {
        if provider.usage_query.access_key_id.trim().is_empty()
            || provider.usage_query.secret_access_key.trim().is_empty()
        {
            return Err("Volcengine AccessKey ID and SecretAccessKey are required".to_string());
        }
        let now = chrono::Utc::now();
        let primary = build_volcengine_request(
            base_source,
            &provider.usage_query.access_key_id,
            &provider.usage_query.secret_access_key,
            "GetAFPUsage",
            now,
        )?;
        let fallback = build_volcengine_request(
            base_source,
            &provider.usage_query.access_key_id,
            &provider.usage_query.secret_access_key,
            "GetCodingPlanUsage",
            now,
        )?;
        return Ok(PreparedQuery {
            primary: PreparedRequest {
                request: primary,
                adapter: ProviderAdapter::VolcengineAfp,
                script: None,
            },
            fallback: Some(PreparedRequest {
                request: fallback,
                adapter: ProviderAdapter::VolcengineCoding,
                script: None,
            }),
            timeout,
        });
    }
    if api_key.trim().is_empty() {
        return Err("Provider API key is not configured".to_string());
    }

    let (adapter, request) = match host.as_str() {
        "api.kimi.com" if base.path().contains("/coding") => (
            ProviderAdapter::Kimi,
            bearer_request("https://api.kimi.com/coding/v1/usages", api_key)?,
        ),
        "open.bigmodel.cn" => (
            ProviderAdapter::Zhipu,
            raw_authorization_request(
                "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
                api_key,
            )?,
        ),
        "api.z.ai" => (
            ProviderAdapter::Zhipu,
            raw_authorization_request("https://api.z.ai/api/monitor/usage/quota/limit", api_key)?,
        ),
        "api.minimaxi.com" => (
            ProviderAdapter::MiniMax,
            bearer_request(
                "https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains",
                api_key,
            )?,
        ),
        "api.minimax.io" => (
            ProviderAdapter::MiniMax,
            bearer_request(
                "https://api.minimax.io/v1/api/openplatform/coding_plan/remains",
                api_key,
            )?,
        ),
        "api.zenmux.com" => (
            ProviderAdapter::ZenMux,
            bearer_request(base.as_str(), api_key)?,
        ),
        _ => return Err("No Coding Plan adapter matches this provider".to_string()),
    };
    Ok(single_request_query(request, adapter, timeout))
}

fn single_request_query(
    request: HttpRequest,
    adapter: ProviderAdapter,
    timeout: Duration,
) -> PreparedQuery {
    PreparedQuery {
        primary: PreparedRequest {
            request,
            adapter,
            script: None,
        },
        fallback: None,
        timeout,
    }
}

fn bearer_request(url: &str, api_key: &str) -> Result<HttpRequest, String> {
    raw_authorization_request(url, &format!("Bearer {api_key}"))
}

fn raw_authorization_request(url: &str, authorization: &str) -> Result<HttpRequest, String> {
    let mut headers = HashMap::new();
    headers.insert("Authorization".to_string(), authorization.to_string());
    headers.insert("Accept".to_string(), "application/json".to_string());
    Ok(HttpRequest {
        url: Url::parse(url).map_err(|_| "Usage adapter URL is invalid".to_string())?,
        method: Method::GET,
        headers,
        body: None,
    })
}

fn validate_standard_destination(request_url: &str, base_url: &str) -> Result<Url, String> {
    let request = validate_destination(request_url)?;
    let base = validate_destination(base_url)?;
    if request.scheme() != base.scheme()
        || request.host_str() != base.host_str()
        || request.port_or_known_default() != base.port_or_known_default()
    {
        return Err("Standard usage templates must use the configured Base URL origin".to_string());
    }
    Ok(request)
}

fn validate_destination(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw.trim()).map_err(|_| "Usage query URL is invalid".to_string())?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Usage query URLs cannot contain credentials".to_string());
    }
    if url.host_str().is_none() {
        return Err("Usage query URL has no host".to_string());
    }
    if url.scheme() != "https" && url.scheme() != "http" {
        return Err("Usage query URL must use HTTP(S)".to_string());
    }
    Ok(url)
}

async fn execute_prepared_query(query: &PreparedQuery) -> Result<Vec<UsageData>, QueryFailure> {
    match execute_prepared_request(&query.primary, query.timeout).await {
        Ok(primary) if !primary.is_empty() => Ok(primary),
        Ok(primary) => match &query.fallback {
            Some(fallback) => execute_prepared_request(fallback, query.timeout).await,
            None => Ok(primary),
        },
        Err(failure) => {
            if should_try_fallback(failure.kind) {
                if let Some(fallback) = &query.fallback {
                    return execute_prepared_request(fallback, query.timeout).await;
                }
            }
            Err(failure)
        }
    }
}

fn should_try_fallback(kind: QueryFailureKind) -> bool {
    kind == QueryFailureKind::Soft
}

async fn execute_prepared_request(
    prepared: &PreparedRequest,
    timeout: Duration,
) -> Result<Vec<UsageData>, QueryFailure> {
    let response = send_bounded_request(&prepared.request, timeout).await?;
    let body = serde_json::from_slice::<Value>(&response.body).ok();
    let volcengine = matches!(
        prepared.adapter,
        ProviderAdapter::VolcengineAfp | ProviderAdapter::VolcengineCoding
    );
    if volcengine {
        if let Some(kind) = body.as_ref().and_then(classify_volcengine_error) {
            let message = match kind {
                QueryFailureKind::Auth => "Volcengine usage authentication failed",
                QueryFailureKind::Soft => "Volcengine usage API rejected the request",
                QueryFailureKind::Transient => "Volcengine usage request failed",
            };
            let mut failure = QueryFailure::new(kind, message);
            // 火山错误体只区分 Auth/Soft(Soft 才触发 fallback);限流/服务端故障
            // (429/5xx + FlowLimitExceeded 等错误体)的确定性以 HTTP 状态为准,
            // 保住 keep-last-good 快照。
            if kind != QueryFailureKind::Auth && !response.status.is_success() {
                failure.deterministic = deterministic_http_status(response.status);
            }
            return Err(failure);
        }
    }
    if response.status == reqwest::StatusCode::UNAUTHORIZED
        || response.status == reqwest::StatusCode::FORBIDDEN
    {
        return Err(QueryFailure::new(
            QueryFailureKind::Auth,
            "Usage query authentication failed",
        ));
    }
    if !response.status.is_success() {
        return Err(QueryFailure::http(
            response.status,
            format!("Usage query failed with HTTP {}", response.status),
        ));
    }
    let response = body.ok_or_else(|| {
        QueryFailure::new(
            QueryFailureKind::Soft,
            "Usage query response is not valid JSON",
        )
    })?;
    if let Some((script, variables)) = &prepared.script {
        extract_script_entries(script, variables, &response)
    } else {
        parse_adapter_response(prepared.adapter, &response)
    }
    .map_err(|message| QueryFailure::new(QueryFailureKind::Soft, message))
}

fn classify_volcengine_error(body: &Value) -> Option<QueryFailureKind> {
    let error = body
        .get("ResponseMetadata")
        .and_then(|metadata| metadata.get("Error"))
        .or_else(|| body.get("Error"))?;
    let code = error.get("Code").and_then(Value::as_str).unwrap_or("");
    let message = error.get("Message").and_then(Value::as_str).unwrap_or("");
    if code.is_empty() && message.is_empty() {
        return None;
    }
    let code = code.to_ascii_lowercase();
    let auth = [
        "auth",
        "signature",
        "accessdenied",
        "denied",
        "unauthorized",
        "forbidden",
        "credential",
        "accesskey",
        "token",
    ]
    .iter()
    .any(|marker| code.contains(marker));
    Some(if auth {
        QueryFailureKind::Auth
    } else {
        QueryFailureKind::Soft
    })
}

async fn send_bounded_request(
    request: &HttpRequest,
    timeout: Duration,
) -> Result<HttpResponse, QueryFailure> {
    // 出网统一走应用代理配置(显式 no_proxy 语义,代理未启用即直连);本地
    // 与公网地址均默认放行,代理配置无效时 fail fast。
    // 例外:回环目标(localhost/127.x/::1)永远直连——代理侧的 localhost 指向
    // 代理所在机器,经代理必然打不到本机服务(本地 NewAPI/one-api 中转是用量
    // 查询的常见目标)。
    let builder = if is_loopback_destination(&request.url) {
        reqwest::Client::builder().no_proxy()
    } else {
        crate::services::system_proxy::async_client_builder()
            .map_err(|message| QueryFailure::new(QueryFailureKind::Transient, message))?
    };
    let client = builder
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(CONNECT_TIMEOUT.min(timeout))
        .timeout(timeout)
        .build()
        .map_err(|_| {
            QueryFailure::new(
                QueryFailureKind::Transient,
                "Unable to create usage query client",
            )
        })?;

    let mut builder = client.request(request.method.clone(), request.url.clone());
    for (name, value) in &request.headers {
        builder = builder.header(name, value);
    }
    if let Some(body) = &request.body {
        builder = builder.body(body.clone());
    }
    let response = builder.send().await.map_err(|_| {
        QueryFailure::new(QueryFailureKind::Transient, "Usage query request failed")
    })?;
    let status = response.status();
    let body = read_limited_response(response)
        .await
        .map_err(|message| QueryFailure::new(QueryFailureKind::Transient, message))?;
    Ok(HttpResponse { status, body })
}

fn is_loopback_destination(url: &Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    host.trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<std::net::IpAddr>()
        .map(|ip| ip.is_loopback())
        .unwrap_or(false)
}

async fn read_limited_response(response: reqwest::Response) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err("Usage query response is too large".to_string());
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "Unable to read usage query response".to_string())?;
        if body.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err("Usage query response is too large".to_string());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn parse_adapter_response(
    adapter: ProviderAdapter,
    body: &Value,
) -> Result<Vec<UsageData>, String> {
    let entries = match adapter {
        ProviderAdapter::DeepSeek => parse_deepseek(body)?,
        ProviderAdapter::StepFun => vec![balance_data(
            "StepFun",
            required_number(body, "balance")?,
            "CNY",
        )],
        ProviderAdapter::StepFunIntl => vec![balance_data(
            "StepFun",
            required_number(body, "balance")?,
            "USD",
        )],
        ProviderAdapter::SiliconFlowCn | ProviderAdapter::SiliconFlowEn => {
            let data = body
                .get("data")
                .ok_or_else(|| "SiliconFlow response is missing data".to_string())?;
            vec![balance_data(
                "SiliconFlow",
                required_number(data, "totalBalance")?,
                if adapter == ProviderAdapter::SiliconFlowCn {
                    "CNY"
                } else {
                    "USD"
                },
            )]
        }
        ProviderAdapter::OpenRouter => {
            let data = body.get("data").unwrap_or(body);
            let total = required_number(data, "total_credits")?;
            let used = required_number(data, "total_usage")?;
            let remaining = total - used;
            vec![UsageData {
                total: Some(total),
                used: Some(used),
                ..invalid_when(
                    balance_data("OpenRouter", remaining, "USD"),
                    remaining <= 0.0,
                    "No credits remaining",
                )
            }]
        }
        ProviderAdapter::Novita => {
            let remaining = required_number(body, "availableBalance")? / 10_000.0;
            vec![invalid_when(
                balance_data("Novita", remaining, "USD"),
                remaining <= 0.0,
                "No balance remaining",
            )]
        }
        ProviderAdapter::Kimi => parse_kimi(body),
        ProviderAdapter::Zhipu => parse_zhipu(body),
        ProviderAdapter::MiniMax => parse_minimax(body),
        ProviderAdapter::ZenMux => parse_zenmux(body)?,
        ProviderAdapter::VolcengineAfp => parse_volcengine_afp(body),
        ProviderAdapter::VolcengineCoding => parse_volcengine_coding(body),
        ProviderAdapter::Script => return Err("Script parser is unavailable".to_string()),
    };
    if entries.len() > MAX_ENTRIES {
        return Err("Usage query returned too many entries".to_string());
    }
    Ok(entries)
}

fn parse_deepseek(body: &Value) -> Result<Vec<UsageData>, String> {
    // 对齐 cc-switch:顶层 is_available=false 表示账户不可用(欠费/暂停)。
    let unavailable = body.get("is_available").and_then(Value::as_bool) == Some(false);
    let infos = body
        .get("balance_infos")
        .and_then(Value::as_array)
        .ok_or_else(|| "DeepSeek response is missing balance information".to_string())?;
    infos
        .iter()
        .map(|info| {
            let unit = info
                .get("currency")
                .and_then(Value::as_str)
                .filter(|unit| !unit.is_empty())
                .ok_or_else(|| "DeepSeek response has an invalid currency".to_string())?;
            Ok(invalid_when(
                balance_data("DeepSeek", required_number(info, "total_balance")?, unit),
                unavailable,
                "Insufficient balance",
            ))
        })
        .collect()
}

fn parse_kimi(body: &Value) -> Vec<UsageData> {
    let mut entries = Vec::new();
    if let Some(limits) = body.get("limits").and_then(Value::as_array) {
        for limit in limits {
            let Some(detail) = limit.get("detail") else {
                continue;
            };
            if let Some(remaining) = optional_number(detail, "remaining") {
                entries.push(window_usage(
                    WINDOW_5H,
                    remaining,
                    optional_number(detail, "limit"),
                    None,
                ));
            }
        }
    }
    if let Some(usage) = body.get("usage") {
        if let Some(remaining) = optional_number(usage, "remaining") {
            entries.push(window_usage(
                WINDOW_WEEKLY,
                remaining,
                optional_number(usage, "limit"),
                None,
            ));
        }
    }
    entries
}

fn parse_zhipu(body: &Value) -> Vec<UsageData> {
    let Some(limits) = body
        .get("data")
        .and_then(|data| data.get("limits"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    limits
        .iter()
        .filter(|item| {
            item.get("type")
                .and_then(Value::as_str)
                .is_some_and(|kind| kind.eq_ignore_ascii_case("TOKENS_LIMIT"))
        })
        .filter_map(|item| {
            let used = optional_number(item, "percentage")?;
            let token = match item.get("unit").and_then(Value::as_i64) {
                Some(3) => WINDOW_5H,
                Some(6) => WINDOW_WEEKLY,
                _ => WINDOW_QUOTA,
            };
            Some(percent_usage(token, 100.0 - used))
        })
        .collect()
}

fn parse_minimax(body: &Value) -> Vec<UsageData> {
    let Some(remains) = body.get("model_remains").and_then(Value::as_array) else {
        return Vec::new();
    };
    let Some(general) = remains.iter().find(|item| {
        item.get("model_name")
            .and_then(Value::as_str)
            .is_some_and(|name| name == "general")
    }) else {
        return Vec::new();
    };
    let mut entries = Vec::new();
    if let Some(remaining) = optional_number(general, "current_interval_remaining_percent") {
        entries.push(percent_usage(WINDOW_5H, remaining));
    }
    if general.get("current_weekly_status").and_then(Value::as_i64) == Some(1) {
        if let Some(remaining) = optional_number(general, "current_weekly_remaining_percent") {
            entries.push(percent_usage(WINDOW_WEEKLY, remaining));
        }
    }
    entries
}

fn parse_zenmux(body: &Value) -> Result<Vec<UsageData>, String> {
    if body.get("success").and_then(Value::as_bool) != Some(true) {
        return Err("ZenMux usage query failed".to_string());
    }
    let Some(data) = body.get("data") else {
        return Ok(Vec::new());
    };
    let mut entries = Vec::new();
    for (field, token) in [("quota_5_hour", WINDOW_5H), ("quota_7_day", WINDOW_WEEKLY)] {
        if let Some(used) = data
            .get(field)
            .and_then(|quota| optional_number(quota, "usage_percentage"))
        {
            entries.push(percent_usage(token, (1.0 - used) * 100.0));
        }
    }
    Ok(entries)
}

fn parse_volcengine_afp(body: &Value) -> Vec<UsageData> {
    let result = body.get("Result").unwrap_or(body);
    let mut entries = Vec::new();
    for (field, token) in [
        ("AFPFiveHour", WINDOW_5H),
        ("AFPWeekly", WINDOW_WEEKLY),
        ("AFPMonthly", WINDOW_MONTHLY),
    ] {
        let Some(window) = result.get(field) else {
            continue;
        };
        let Some(quota) = optional_number(window, "Quota") else {
            continue;
        };
        if quota <= 0.0 {
            continue;
        }
        let used = optional_number(window, "Used").unwrap_or(0.0);
        entries.push(window_usage(token, quota - used, Some(quota), None));
    }
    entries
}

fn parse_volcengine_coding(body: &Value) -> Vec<UsageData> {
    let result = body.get("Result").unwrap_or(body);
    let Some(usages) = result
        .get("QuotaUsage")
        .and_then(Value::as_array)
        .or_else(|| result.get("Usages").and_then(Value::as_array))
        .or_else(|| result.get("Details").and_then(Value::as_array))
    else {
        return Vec::new();
    };
    usages
        .iter()
        .filter_map(|item| {
            let level = item
                .get("Level")
                .or_else(|| item.get("Type"))
                .or_else(|| item.get("Period"))
                .and_then(Value::as_str)?;
            let token = match level.to_ascii_lowercase().as_str() {
                "session" | "5h" | "fivehour" | "five_hour" | "rolling_5h" => WINDOW_5H,
                "weekly" | "week" | "7d" => WINDOW_WEEKLY,
                "monthly" | "month" => WINDOW_MONTHLY,
                _ => return None,
            };
            let used = optional_number(item, "Percent")
                .or_else(|| optional_number(item, "UsedPercent"))
                .or_else(|| optional_number(item, "UsagePercent"))?;
            Some(percent_usage(token, 100.0 - used))
        })
        .collect()
}

// 配额窗口用稳定 token 作 planName(前端 i18n 映射;未识别 token 原样展示)。
const WINDOW_5H: &str = "window:5h";
const WINDOW_WEEKLY: &str = "window:weekly";
const WINDOW_MONTHLY: &str = "window:monthly";
const WINDOW_QUOTA: &str = "window:quota";

fn window_usage(token: &str, remaining: f64, total: Option<f64>, unit: Option<&str>) -> UsageData {
    UsageData {
        plan_name: Some(token.to_string()),
        remaining: Some(remaining),
        total,
        used: total.map(|total| total - remaining),
        unit: unit.map(str::to_string),
        ..UsageData::default()
    }
}

fn percent_usage(token: &str, remaining: f64) -> UsageData {
    window_usage(token, remaining, Some(100.0), Some("%"))
}

fn balance_data(brand: &str, remaining: f64, unit: &str) -> UsageData {
    UsageData {
        plan_name: Some(brand.to_string()),
        remaining: Some(remaining),
        unit: Some(unit.to_string()),
        ..UsageData::default()
    }
}

fn invalid_when(mut data: UsageData, invalid: bool, message: &str) -> UsageData {
    if invalid {
        data.is_valid = Some(false);
        data.invalid_message = Some(message.to_string());
    }
    data
}

fn required_number(value: &Value, field: &str) -> Result<f64, String> {
    optional_number(value, field)
        .ok_or_else(|| "Usage query response is missing a number".to_string())
}

fn optional_number(value: &Value, field: &str) -> Option<f64> {
    let value = value.get(field)?;
    let number = value
        .as_f64()
        .or_else(|| value.as_str().and_then(|value| value.parse::<f64>().ok()))?;
    number.is_finite().then_some(number)
}

fn build_volcengine_request(
    base_url: &str,
    access_key_id: &str,
    secret_access_key: &str,
    action: &str,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<HttpRequest, String> {
    if !matches!(action, "GetAFPUsage" | "GetCodingPlanUsage") {
        return Err("Unsupported Volcengine usage action".to_string());
    }
    let base = Url::parse(base_url).map_err(|_| "Volcengine Base URL is invalid".to_string())?;
    let region = base
        .host_str()
        .unwrap_or_default()
        .split('.')
        .find(|part| part.starts_with("cn-") || part.starts_with("ap-"))
        .unwrap_or("cn-beijing");
    let canonical_query = format!("Action={action}&Region={region}&Version=2024-01-01");
    let body = b"";
    let x_date = now.format("%Y%m%dT%H%M%SZ").to_string();
    let short_date = now.format("%Y%m%d").to_string();
    let content_hash = sha256_hex(body);
    let signed_headers = "content-type;host;x-content-sha256;x-date";
    let content_type = "application/json; charset=utf-8";
    let canonical_headers = format!(
        "content-type:{content_type}\nhost:open.volcengineapi.com\nx-content-sha256:{content_hash}\nx-date:{x_date}\n"
    );
    let canonical_request = format!(
        "POST\n/\n{canonical_query}\n{canonical_headers}\n{signed_headers}\n{content_hash}"
    );
    let scope = format!("{short_date}/{region}/ark/request");
    let string_to_sign = format!(
        "HMAC-SHA256\n{x_date}\n{scope}\n{}",
        sha256_hex(canonical_request.as_bytes())
    );
    let k_date = hmac_sha256(secret_access_key.as_bytes(), short_date.as_bytes());
    let k_region = hmac_sha256(&k_date, region.as_bytes());
    let k_service = hmac_sha256(&k_region, b"ark");
    let k_signing = hmac_sha256(&k_service, b"request");
    let signature = hex_encode(&hmac_sha256(&k_signing, string_to_sign.as_bytes()));
    let authorization = format!(
        "HMAC-SHA256 Credential={access_key_id}/{scope}, SignedHeaders={signed_headers}, Signature={signature}"
    );

    let mut headers = HashMap::new();
    headers.insert("Authorization".to_string(), authorization);
    headers.insert("X-Date".to_string(), x_date);
    headers.insert("X-Content-Sha256".to_string(), content_hash);
    headers.insert("Content-Type".to_string(), content_type.to_string());
    Ok(HttpRequest {
        url: Url::parse(&format!(
            "https://open.volcengineapi.com/?{canonical_query}"
        ))
        .map_err(|_| "Volcengine usage URL is invalid".to_string())?,
        method: Method::POST,
        headers,
        body: Some(String::new()),
    })
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
    const BLOCK_BYTES: usize = 64;
    let mut normalized = [0_u8; BLOCK_BYTES];
    if key.len() > BLOCK_BYTES {
        normalized[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        normalized[..key.len()].copy_from_slice(key);
    }
    let mut inner_pad = [0x36_u8; BLOCK_BYTES];
    let mut outer_pad = [0x5c_u8; BLOCK_BYTES];
    for index in 0..BLOCK_BYTES {
        inner_pad[index] ^= normalized[index];
        outer_pad[index] ^= normalized[index];
    }
    let mut inner = Sha256::new();
    inner.update(inner_pad);
    inner.update(data);
    let inner_hash = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(outer_pad);
    outer.update(inner_hash);
    outer.finalize().into()
}

fn sha256_hex(data: &[u8]) -> String {
    hex_encode(&Sha256::digest(data))
}

fn hex_encode(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut result = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(result, "{byte:02x}");
    }
    result
}

#[derive(Deserialize)]
struct ScriptRequest {
    url: String,
    method: String,
    #[serde(default)]
    headers: HashMap<String, String>,
    #[serde(default)]
    body: Option<String>,
}

fn evaluate_script_request(
    script: &str,
    variables: &ScriptVariables,
) -> Result<HttpRequest, String> {
    validate_script_size(script)?;
    let rendered = render_script(script, variables)?;
    let (_runtime, context) = create_script_sandbox()?;
    let request_json = context.with(|ctx| {
        let config: rquickjs::Object = ctx
            .eval(rendered.as_bytes())
            .map_err(|_| "Usage script could not be evaluated".to_string())?;
        let request: rquickjs::Object = config
            .get("request")
            .map_err(|_| "Usage script is missing request".to_string())?;
        let json = ctx
            .json_stringify(request)
            .map_err(|_| "Usage script request could not be serialized".to_string())?
            .ok_or_else(|| "Usage script request could not be serialized".to_string())?;
        json.to_string()
            .map_err(|_| "Usage script request could not be serialized".to_string())
    })?;
    if request_json.len() > MAX_SCRIPT_OUTPUT_BYTES {
        return Err("Usage script request is too large".to_string());
    }
    let request: ScriptRequest = serde_json::from_str(&request_json)
        .map_err(|_| "Usage script request has an invalid shape".to_string())?;
    validate_script_request(request)
}

fn extract_script_entries(
    script: &str,
    _variables: &ScriptVariables,
    response: &Value,
) -> Result<Vec<UsageData>, String> {
    validate_script_size(script)?;
    let rendered = render_script(script, &ScriptVariables::default())?;
    let response_json = serde_json::to_vec(response)
        .map_err(|_| "Usage response could not be prepared for the script".to_string())?;
    if response_json.len() > MAX_RESPONSE_BYTES {
        return Err("Usage query response is too large".to_string());
    }
    let (_runtime, context) = create_script_sandbox()?;
    let result_json = context.with(|ctx| {
        let config: rquickjs::Object = ctx
            .eval(rendered.as_bytes())
            .map_err(|_| "Usage script could not be evaluated".to_string())?;
        let extractor: Function = config
            .get("extractor")
            .map_err(|_| "Usage script is missing extractor".to_string())?;
        let response = ctx
            .json_parse(response_json)
            .map_err(|_| "Usage response could not be passed to the script".to_string())?;
        let result: rquickjs::Value = extractor
            .call((response,))
            .map_err(|_| "Usage script extractor failed".to_string())?;
        let json = ctx
            .json_stringify(result)
            .map_err(|_| "Usage script result could not be serialized".to_string())?
            .ok_or_else(|| "Usage script result could not be serialized".to_string())?;
        json.to_string()
            .map_err(|_| "Usage script result could not be serialized".to_string())
    })?;
    if result_json.len() > MAX_SCRIPT_OUTPUT_BYTES {
        return Err("Usage script result is too large".to_string());
    }
    let result: Value = serde_json::from_str(&result_json)
        .map_err(|_| "Usage script result is not valid JSON".to_string())?;
    parse_script_result(&result)
}

fn create_script_sandbox() -> Result<(Runtime, Context), String> {
    let runtime =
        Runtime::new().map_err(|_| "Unable to create usage script runtime".to_string())?;
    runtime.set_memory_limit(16 * 1024 * 1024);
    runtime.set_max_stack_size(512 * 1024);
    let deadline = Instant::now() + SCRIPT_TIMEOUT;
    runtime.set_interrupt_handler(Some(Box::new(move || Instant::now() >= deadline)));
    let context = Context::builder()
        .with::<rquickjs::context::intrinsic::Eval>()
        .with::<rquickjs::context::intrinsic::Json>()
        .build(&runtime)
        .map_err(|_| "Unable to create usage script context".to_string())?;
    Ok((runtime, context))
}

fn validate_script_size(script: &str) -> Result<(), String> {
    if script.is_empty() || script.len() > MAX_SCRIPT_BYTES {
        return Err("Usage script size is invalid".to_string());
    }
    Ok(())
}

fn render_script(script: &str, variables: &ScriptVariables) -> Result<String, String> {
    let replacements = [
        ("{{apiKey}}", variables.api_key.as_str()),
        ("{{baseUrl}}", variables.base_url.as_str()),
        ("{{accessToken}}", variables.access_token.as_str()),
        ("{{userId}}", variables.user_id.as_str()),
    ]
    .map(|(placeholder, value)| {
        if value.len() > MAX_SCRIPT_VARIABLE_BYTES {
            return Err("Usage script variable is too large".to_string());
        }
        let json = serde_json::to_string(value)
            .map_err(|_| "Unable to prepare usage script variables".to_string())?;
        let escaped = json
            .strip_prefix('"')
            .and_then(|value| value.strip_suffix('"'))
            .ok_or_else(|| "Unable to prepare usage script variables".to_string())?;
        Ok((placeholder, escaped.to_string()))
    });
    let replacements = replacements
        .into_iter()
        .collect::<Result<Vec<_>, String>>()?;

    let mut rendered = String::with_capacity(script.len());
    let mut remaining = script;
    while !remaining.is_empty() {
        let next = replacements
            .iter()
            .filter_map(|(placeholder, value)| {
                remaining
                    .find(placeholder)
                    .map(|index| (index, *placeholder, value.as_str()))
            })
            .min_by_key(|(index, _, _)| *index);
        let Some((index, placeholder, value)) = next else {
            push_script_fragment(&mut rendered, remaining)?;
            break;
        };
        push_script_fragment(&mut rendered, &remaining[..index])?;
        push_script_fragment(&mut rendered, value)?;
        remaining = &remaining[index + placeholder.len()..];
    }
    Ok(rendered)
}

fn push_script_fragment(rendered: &mut String, fragment: &str) -> Result<(), String> {
    if rendered.len().saturating_add(fragment.len()) > MAX_SCRIPT_BYTES {
        return Err("Rendered usage script is too large".to_string());
    }
    rendered.push_str(fragment);
    Ok(())
}

fn validate_script_request(request: ScriptRequest) -> Result<HttpRequest, String> {
    let method = match request.method.to_ascii_uppercase().as_str() {
        "GET" => Method::GET,
        "POST" => Method::POST,
        _ => return Err("Usage script request method must be GET or POST".to_string()),
    };
    if request.headers.len() > MAX_HEADERS {
        return Err("Usage script request has too many headers".to_string());
    }
    let mut header_bytes = 0_usize;
    for (name, value) in &request.headers {
        header_bytes = header_bytes
            .saturating_add(name.len())
            .saturating_add(value.len());
        let lower = name.to_ascii_lowercase();
        if matches!(
            lower.as_str(),
            "host"
                | "content-length"
                | "transfer-encoding"
                | "connection"
                | "proxy-authorization"
                | "proxy-connection"
                | "upgrade"
        ) || reqwest::header::HeaderName::from_bytes(name.as_bytes()).is_err()
            || reqwest::header::HeaderValue::from_str(value).is_err()
        {
            return Err("Usage script request contains an invalid header".to_string());
        }
    }
    if header_bytes > MAX_HEADER_BYTES {
        return Err("Usage script request headers are too large".to_string());
    }
    if request
        .body
        .as_ref()
        .is_some_and(|body| body.len() > MAX_REQUEST_BODY_BYTES)
    {
        return Err("Usage script request body is too large".to_string());
    }
    Ok(HttpRequest {
        url: Url::parse(&request.url)
            .map_err(|_| "Usage script request URL is invalid".to_string())?,
        method,
        headers: request.headers,
        body: request.body,
    })
}

// extractor 返回值校验:对齐 cc-switch validate_single_usage——单对象自动包
// 数组、八字段全可选、null 视为缺失、类型不符逐字段报错;total 允许 -1(前端
// 渲染 ∞)。完全空的条目视为脚本缺陷。
fn parse_script_result(result: &Value) -> Result<Vec<UsageData>, String> {
    let items = if let Some(items) = result.as_array() {
        if items.is_empty() {
            return Err("Usage script returned an empty result".to_string());
        }
        items.iter().collect::<Vec<_>>()
    } else {
        vec![result]
    };
    if items.len() > MAX_ENTRIES {
        return Err("Usage script returned too many entries".to_string());
    }
    items.into_iter().map(parse_script_usage).collect()
}

fn parse_script_usage(item: &Value) -> Result<UsageData, String> {
    let object = item
        .as_object()
        .ok_or_else(|| "Usage script result entries must be objects".to_string())?;
    let data = UsageData {
        // 兼容旧脚本的 label 字段;planName 优先。
        plan_name: script_string(object, "planName", 128)?.or(script_string(object, "label", 128)?),
        extra: script_string(object, "extra", 256)?,
        is_valid: script_bool(object, "isValid")?,
        invalid_message: script_string(object, "invalidMessage", 256)?,
        total: script_number(object, "total")?,
        used: script_number(object, "used")?,
        remaining: script_number(object, "remaining")?,
        unit: script_string(object, "unit", 64)?,
    };
    if data == UsageData::default() {
        return Err("Usage script result entry is empty".to_string());
    }
    Ok(data)
}

fn script_string(
    object: &serde_json::Map<String, Value>,
    field: &str,
    max_len: usize,
) -> Result<Option<String>, String> {
    match object.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => {
            if value.len() > max_len {
                return Err(format!("Usage script field `{field}` is too long"));
            }
            Ok((!value.is_empty()).then(|| value.clone()))
        }
        Some(_) => Err(format!("Usage script field `{field}` must be a string")),
    }
}

fn script_number(
    object: &serde_json::Map<String, Value>,
    field: &str,
) -> Result<Option<f64>, String> {
    match object.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_f64()
            .filter(|value| value.is_finite())
            .map(Some)
            .ok_or_else(|| format!("Usage script field `{field}` must be a finite number")),
    }
}

fn script_bool(
    object: &serde_json::Map<String, Value>,
    field: &str,
) -> Result<Option<bool>, String> {
    match object.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        Some(_) => Err(format!("Usage script field `{field}` must be a boolean")),
    }
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn loopback_destinations_bypass_the_app_proxy() {
        for raw in [
            "http://localhost:3457/account/summary",
            "http://LOCALHOST:3457/x",
            "http://127.0.0.1:8080/x",
            "http://127.8.8.8/x",
            "https://[::1]:9000/x",
        ] {
            assert!(
                is_loopback_destination(&Url::parse(raw).expect("url")),
                "{raw} must be treated as loopback",
            );
        }
        for raw in [
            "https://api.example.test/x",
            "http://192.168.1.10:3000/x",
            "http://10.0.0.1/x",
            "http://localhost.example.test/x",
        ] {
            assert!(
                !is_loopback_destination(&Url::parse(raw).expect("url")),
                "{raw} must not be treated as loopback",
            );
        }
    }

    #[test]
    fn destination_policy_rejects_credentials_and_non_http_schemes() {
        assert!(validate_destination("https://user:pass@example.test").is_err());
        assert!(validate_destination("ftp://example.test").is_err());
        assert!(validate_destination("file:///etc/passwd").is_err());
        assert!(validate_destination("not a url").is_err());
        assert!(validate_destination("https://api.example.test").is_ok());
        // 本地/私网地址与 http 默认放行(经应用代理配置出网)。
        assert!(validate_destination("http://127.0.0.1:8080").is_ok());
        assert!(validate_destination("https://[::1]").is_ok());
        assert!(validate_destination("http://192.168.1.10:3000").is_ok());
        assert!(validate_destination("https://169.254.169.254/latest").is_ok());
    }

    #[tokio::test]
    async fn transport_does_not_follow_redirects() {
        let (url, server) = serve_once(|address| {
            format!(
                "HTTP/1.1 302 Found\r\nLocation: http://{address}/secret\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            )
        })
        .await;
        let request = HttpRequest {
            url,
            method: Method::GET,
            headers: HashMap::new(),
            body: None,
        };

        let response = send_bounded_request(&request, Duration::from_secs(5))
            .await
            .expect("redirect response");
        assert_eq!(response.status, reqwest::StatusCode::FOUND);
        server.await.expect("server task");
    }

    #[tokio::test]
    async fn transport_rejects_oversized_content_length() {
        let (url, server) = serve_once(|_| {
            format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                MAX_RESPONSE_BYTES + 1
            )
        })
        .await;
        let request = HttpRequest {
            url,
            method: Method::GET,
            headers: HashMap::new(),
            body: None,
        };

        let failure = send_bounded_request(&request, Duration::from_secs(5))
            .await
            .expect_err("oversized response must fail");
        assert_eq!(failure.kind, QueryFailureKind::Transient);
        assert!(!failure.deterministic);
        assert_eq!(failure.message, "Usage query response is too large");
        server.await.expect("server task");
    }

    #[test]
    fn standard_templates_require_same_origin() {
        assert!(validate_standard_destination(
            "https://api.example.test/user/balance",
            "https://api.example.test/v1",
        )
        .is_ok());
        // 本地 http 端点(如自建 NewAPI)默认放行,但仍要求与 Base URL 同源。
        assert!(validate_standard_destination(
            "http://127.0.0.1:3000/user/balance",
            "http://127.0.0.1:3000/v1",
        )
        .is_ok());
        assert!(validate_standard_destination(
            "https://other.example.test/user/balance",
            "https://api.example.test/v1",
        )
        .is_err());
        assert!(validate_standard_destination(
            "http://api.example.test/user/balance",
            "https://api.example.test/v1",
        )
        .is_err());
    }

    #[test]
    fn cache_keeps_last_successful_result_after_refresh_failure() {
        let mut cache = UsageCache::default();
        let identity = [7_u8; 32];
        cache.record_success(
            "provider-a",
            identity,
            ProviderUsageResult {
                data: vec![balance_data("Balance", 4.2, "USD")],
                queried_at: Some(123),
                error: None,
                is_stale: false,
            },
        );
        cache.record_failure("provider-a", identity, "request timed out");

        let result = cache.get("provider-a", &identity).expect("cached result");
        assert_eq!(result.data[0].remaining, Some(4.2));
        assert_eq!(result.error.as_deref(), Some("request timed out"));
        assert!(result.is_stale);
    }

    #[test]
    fn cache_returns_an_error_without_inventing_stale_values() {
        let mut cache = UsageCache::default();
        let identity = [7_u8; 32];
        let result = cache.record_failure("provider-a", identity, "request failed");

        assert!(result.data.is_empty());
        assert_eq!(result.error.as_deref(), Some("request failed"));
        assert!(!result.is_stale);
        assert!(cache.get("provider-a", &identity).is_none());
    }

    #[test]
    fn cache_requires_current_provider_identity_and_supports_invalidation() {
        let mut cache = UsageCache::default();
        let original = test_provider("coding-plan", "https://api.kimi.com/coding/v1");
        let original_identity = provider_query_identity(&original);
        cache.record_success(
            "provider-a",
            original_identity,
            ProviderUsageResult {
                data: vec![balance_data("Balance", 4.2, "USD")],
                queried_at: Some(123),
                error: None,
                is_stale: false,
            },
        );

        assert!(cache.get("provider-a", &original_identity).is_some());
        let mut edited = original.clone();
        edited.api_key = "different-account-secret".to_string();
        assert!(cache
            .get("provider-a", &provider_query_identity(&edited))
            .is_none());

        cache.invalidate("provider-a");
        assert!(cache.get("provider-a", &original_identity).is_none());

        let mut disabled = original.clone();
        disabled.usage_query.enabled = false;
        assert!(prepare_query(&disabled).is_err());
        let mut retyped = original;
        retyped.provider_type = "unsupported".to_string();
        assert!(prepare_query(&retyped).is_err());
    }

    #[test]
    fn query_identity_tracks_credential_overrides_timeout_and_effective_script() {
        let base = test_provider("general", "https://api.example.test/v1");
        let base_identity = provider_query_identity(&base);

        let mut key_override = base.clone();
        key_override.usage_query.api_key = "query-only-secret".to_string();
        assert_ne!(base_identity, provider_query_identity(&key_override));

        let mut timeout = base.clone();
        timeout.usage_query.timeout_secs = Some(20.0);
        assert_ne!(base_identity, provider_query_identity(&timeout));

        // general 空脚本走内置预设:显式落一份与预设一致的脚本不改变 identity,
        // 改动脚本内容才改变。
        let mut explicit = base.clone();
        explicit.usage_query.script = GENERAL_SCRIPT.to_string();
        assert_eq!(base_identity, provider_query_identity(&explicit));
        let mut edited = base.clone();
        edited.usage_query.script = GENERAL_SCRIPT.replace("USD", "CNY");
        assert_ne!(base_identity, provider_query_identity(&edited));
    }

    #[test]
    fn failure_only_results_are_not_reusable_cache_entries() {
        let mut cache = UsageCache::default();
        let provider = test_provider("coding-plan", "https://api.kimi.com/coding/v1");
        let identity = provider_query_identity(&provider);

        let result = cache.record_failure("provider-a", identity, "request failed");

        assert!(result.data.is_empty());
        assert_eq!(result.error.as_deref(), Some("request failed"));
        assert!(cache.get("provider-a", &identity).is_none());
    }

    #[test]
    fn balance_adapters_build_expected_endpoints() {
        let cases = [
            (
                "https://api.deepseek.com/v1",
                ProviderAdapter::DeepSeek,
                "https://api.deepseek.com/user/balance",
            ),
            (
                "https://api.stepfun.com/v1",
                ProviderAdapter::StepFun,
                "https://api.stepfun.com/v1/accounts",
            ),
            // 国际站独立账号体系:不得把 .ai 的 Key 发往国内站端点。
            (
                "https://api.stepfun.ai/v1",
                ProviderAdapter::StepFunIntl,
                "https://api.stepfun.ai/v1/accounts",
            ),
            (
                "https://api.siliconflow.cn/v1",
                ProviderAdapter::SiliconFlowCn,
                "https://api.siliconflow.cn/v1/user/info",
            ),
            (
                "https://api.siliconflow.com/v1",
                ProviderAdapter::SiliconFlowEn,
                "https://api.siliconflow.com/v1/user/info",
            ),
            (
                "https://openrouter.ai/api/v1",
                ProviderAdapter::OpenRouter,
                "https://openrouter.ai/api/v1/credits",
            ),
            (
                "https://api.novita.ai/v3/openai",
                ProviderAdapter::Novita,
                "https://api.novita.ai/v3/user/balance",
            ),
        ];

        for (base_url, expected_adapter, expected_url) in cases {
            let query = test_provider("balance", base_url);
            let prepared = prepare_query(&query).expect("prepare balance query");
            assert_eq!(prepared.primary.adapter, expected_adapter);
            assert_eq!(prepared.primary.request.url.as_str(), expected_url);
        }

        assert!(prepare_query(&test_provider("balance", "http://api.deepseek.com/v1")).is_err());
        assert!(prepare_query(&test_provider("balance", "https://api.other.example/v1")).is_err());
    }

    #[test]
    fn balance_adapter_responses_are_normalized() {
        let cases = [
            (
                ProviderAdapter::DeepSeek,
                json!({"balance_infos": [{"currency": "CNY", "total_balance": "12.50"}]}),
                "DeepSeek",
                12.5,
                "CNY",
            ),
            (
                ProviderAdapter::StepFun,
                json!({"balance": 9.25}),
                "StepFun",
                9.25,
                "CNY",
            ),
            (
                ProviderAdapter::StepFunIntl,
                json!({"balance": 3.5}),
                "StepFun",
                3.5,
                "USD",
            ),
            (
                ProviderAdapter::SiliconFlowEn,
                json!({"data": {"totalBalance": "8.75"}}),
                "SiliconFlow",
                8.75,
                "USD",
            ),
            (
                ProviderAdapter::OpenRouter,
                json!({"data": {"total_credits": 20, "total_usage": 3.5}}),
                "OpenRouter",
                16.5,
                "USD",
            ),
            (
                ProviderAdapter::Novita,
                json!({"availableBalance": 42_000}),
                "Novita",
                4.2,
                "USD",
            ),
        ];

        for (adapter, body, brand, remaining, unit) in cases {
            let entries = parse_adapter_response(adapter, &body).expect("parse adapter response");
            assert_eq!(entries[0].plan_name.as_deref(), Some(brand));
            assert_eq!(entries[0].remaining, Some(remaining));
            assert_eq!(entries[0].unit.as_deref(), Some(unit));
            assert_eq!(entries[0].is_valid, None);
        }
    }

    #[test]
    fn balance_adapters_flag_unavailable_and_exhausted_accounts() {
        // 对齐 cc-switch:DeepSeek is_available=false、OpenRouter/Novita 零余额
        // 都要带 isValid=false 让前端标红,而不是渲染成正常余额行。
        let deepseek = parse_adapter_response(
            ProviderAdapter::DeepSeek,
            &json!({
                "is_available": false,
                "balance_infos": [{"currency": "CNY", "total_balance": "0.00"}]
            }),
        )
        .expect("parse deepseek");
        assert_eq!(deepseek[0].is_valid, Some(false));
        assert_eq!(
            deepseek[0].invalid_message.as_deref(),
            Some("Insufficient balance")
        );

        let openrouter = parse_adapter_response(
            ProviderAdapter::OpenRouter,
            &json!({"data": {"total_credits": 10, "total_usage": 10}}),
        )
        .expect("parse openrouter");
        assert_eq!(openrouter[0].is_valid, Some(false));
        assert_eq!(openrouter[0].total, Some(10.0));

        let novita =
            parse_adapter_response(ProviderAdapter::Novita, &json!({"availableBalance": 0}))
                .expect("parse novita");
        assert_eq!(novita[0].is_valid, Some(false));
        assert_eq!(
            novita[0].invalid_message.as_deref(),
            Some("No balance remaining")
        );
    }

    #[test]
    fn coding_plan_adapters_build_expected_endpoints() {
        let cases = [
            (
                "https://api.kimi.com/coding",
                ProviderAdapter::Kimi,
                "/coding/v1/usages",
            ),
            (
                "https://open.bigmodel.cn/api/paas/v4",
                ProviderAdapter::Zhipu,
                "/api/monitor/usage/quota/limit",
            ),
            (
                "https://api.z.ai/api/paas/v4",
                ProviderAdapter::Zhipu,
                "/api/monitor/usage/quota/limit",
            ),
            (
                "https://api.minimaxi.com/v1",
                ProviderAdapter::MiniMax,
                "/v1/api/openplatform/coding_plan/remains",
            ),
            (
                "https://api.minimax.io/v1",
                ProviderAdapter::MiniMax,
                "/v1/api/openplatform/coding_plan/remains",
            ),
            (
                "https://api.zenmux.com/v1/usage",
                ProviderAdapter::ZenMux,
                "/v1/usage",
            ),
        ];

        for (base_url, expected_adapter, expected_path) in cases {
            let query = test_provider("coding-plan", base_url);
            let prepared = prepare_query(&query).expect("prepare coding plan query");
            assert_eq!(prepared.primary.adapter, expected_adapter);
            assert_eq!(prepared.primary.request.url.path(), expected_path);
        }
    }

    #[test]
    fn coding_plan_rejects_zenmux_lookalike_hosts() {
        for base_url in [
            "https://evil-zenmux.example/api/usage",
            "https://api.zenmux.com.attacker.example/usage",
            "https://zenmux.ai/api/usage",
        ] {
            assert!(prepare_query(&test_provider("coding-plan", base_url)).is_err());
        }
        assert!(prepare_query(&test_provider(
            "coding-plan",
            "https://API.ZENMUX.COM/v1/usage",
        ))
        .is_ok());
    }

    #[test]
    fn coding_plan_responses_are_normalized_as_remaining_quota() {
        let cases = [
            (
                ProviderAdapter::Kimi,
                json!({
                    "limits": [{"detail": {"limit": 100, "remaining": 40}}],
                    "usage": {"limit": 1000, "remaining": 700}
                }),
                vec![
                    (WINDOW_5H, 40.0, Some(100.0), None),
                    (WINDOW_WEEKLY, 700.0, Some(1000.0), None),
                ],
            ),
            (
                ProviderAdapter::Zhipu,
                json!({"data": {"limits": [
                    {"type": "TOKENS_LIMIT", "unit": 3, "percentage": 25},
                    {"type": "TOKENS_LIMIT", "unit": 6, "percentage": 60}
                ]}}),
                vec![
                    (WINDOW_5H, 75.0, Some(100.0), Some("%")),
                    (WINDOW_WEEKLY, 40.0, Some(100.0), Some("%")),
                ],
            ),
            (
                ProviderAdapter::MiniMax,
                json!({"model_remains": [{
                    "model_name": "general",
                    "current_interval_remaining_percent": 80,
                    "current_weekly_status": 1,
                    "current_weekly_remaining_percent": 55
                }]}),
                vec![
                    (WINDOW_5H, 80.0, Some(100.0), Some("%")),
                    (WINDOW_WEEKLY, 55.0, Some(100.0), Some("%")),
                ],
            ),
            (
                ProviderAdapter::ZenMux,
                json!({"success": true, "data": {
                    "quota_5_hour": {"usage_percentage": 0.2},
                    "quota_7_day": {"usage_percentage": 0.75}
                }}),
                vec![
                    (WINDOW_5H, 80.0, Some(100.0), Some("%")),
                    (WINDOW_WEEKLY, 25.0, Some(100.0), Some("%")),
                ],
            ),
            (
                ProviderAdapter::VolcengineAfp,
                json!({"Result": {
                    "AFPFiveHour": {"Quota": 50, "Used": 12.5},
                    "AFPWeekly": {"Quota": 500, "Used": 150}
                }}),
                vec![
                    (WINDOW_5H, 37.5, Some(50.0), None),
                    (WINDOW_WEEKLY, 350.0, Some(500.0), None),
                ],
            ),
            (
                ProviderAdapter::VolcengineCoding,
                json!({"Result": {"QuotaUsage": [
                    {"Level": "session", "Percent": 20},
                    {"Level": "weekly", "Percent": 35}
                ]}}),
                vec![
                    (WINDOW_5H, 80.0, Some(100.0), Some("%")),
                    (WINDOW_WEEKLY, 65.0, Some(100.0), Some("%")),
                ],
            ),
        ];

        for (adapter, body, expected) in cases {
            let entries = parse_adapter_response(adapter, &body).expect("parse quota response");
            let actual = entries
                .iter()
                .map(|entry| {
                    (
                        entry.plan_name.as_deref().unwrap_or_default(),
                        entry.remaining.unwrap_or(f64::NAN),
                        entry.total,
                        entry.unit.as_deref(),
                    )
                })
                .collect::<Vec<_>>();
            assert_eq!(actual, expected);
        }
    }

    #[test]
    fn script_request_is_bounded_and_has_no_host_capabilities() {
        let script = r#"({
          request: {
            url: "https://api.example.test/usage",
            method: "GET",
            headers: {
              "x-fetch": typeof fetch,
              "x-process": typeof process,
              "x-require": typeof require
            }
          },
          extractor: (response) => ({ remaining: response.remaining, unit: "USD" })
        })"#;
        let request =
            evaluate_script_request(script, &ScriptVariables::default()).expect("evaluate request");
        assert_eq!(
            request.headers.get("x-fetch").map(String::as_str),
            Some("undefined")
        );
        assert_eq!(
            request.headers.get("x-process").map(String::as_str),
            Some("undefined")
        );
        assert_eq!(
            request.headers.get("x-require").map(String::as_str),
            Some("undefined")
        );

        let oversized = "x".repeat(MAX_SCRIPT_BYTES + 1);
        assert!(evaluate_script_request(&oversized, &ScriptVariables::default()).is_err());
    }

    #[test]
    fn script_extractor_accepts_optional_fields_and_rejects_bad_types() {
        let script = r#"({
          request: { url: "https://api.example.test/usage", method: "GET" },
          extractor: (response) => response
        })"#;
        let valid = extract_script_entries(
            script,
            &ScriptVariables::default(),
            &json!({"remaining": 4.2, "unit": "USD"}),
        )
        .expect("valid script result");
        assert_eq!(valid[0].remaining, Some(4.2));
        assert_eq!(valid[0].unit.as_deref(), Some("USD"));

        // 富模型:字段全可选、类型校验、多套餐数组、total=-1 表示无限。
        let rich = extract_script_entries(
            script,
            &ScriptVariables::default(),
            &json!([
                {
                    "planName": "Pro",
                    "total": 100,
                    "used": 30,
                    "remaining": 70,
                    "unit": "%",
                    "extra": "resets 2026-08-01"
                },
                {"planName": "Bonus", "total": -1, "remaining": 5},
                {"isValid": false, "invalidMessage": "expired"}
            ]),
        )
        .expect("rich script result");
        assert_eq!(rich.len(), 3);
        assert_eq!(rich[0].plan_name.as_deref(), Some("Pro"));
        assert_eq!(rich[0].used, Some(30.0));
        assert_eq!(rich[1].total, Some(-1.0));
        assert_eq!(rich[2].is_valid, Some(false));
        assert_eq!(rich[2].invalid_message.as_deref(), Some("expired"));

        for invalid in [
            json!({"remaining": "secret"}),
            json!({"isValid": "yes"}),
            json!({"planName": 42}),
            json!({}),
            json!([]),
            json!("remaining"),
        ] {
            assert!(
                extract_script_entries(script, &ScriptVariables::default(), &invalid).is_err(),
                "{invalid} must be rejected",
            );
        }
    }

    #[test]
    fn script_extractor_cannot_access_request_credentials() {
        let variables = ScriptVariables {
            api_key: "api-secret".to_string(),
            base_url: "https://private.example.test".to_string(),
            access_token: "access-secret".to_string(),
            user_id: "user-secret".to_string(),
        };
        let script = r#"({
          request: {
            url: "{{baseUrl}}/usage",
            method: "GET",
            headers: {
              "Authorization": "Bearer {{apiKey}}",
              "x-access-token": "{{accessToken}}",
              "x-user-id": "{{userId}}"
            }
          },
          extractor: (response) => ({
            remaining: response.remaining,
            label: "sanitized:{{apiKey}}:{{userId}}:{{baseUrl}}",
            unit: "token:{{accessToken}}"
          })
        })"#;

        let request = evaluate_script_request(script, &variables).expect("evaluate request");
        assert_eq!(request.url.as_str(), "https://private.example.test/usage");
        assert_eq!(
            request.headers.get("Authorization").map(String::as_str),
            Some("Bearer api-secret")
        );

        let entries = extract_script_entries(script, &variables, &json!({"remaining": 4.2}))
            .expect("extract response");
        assert_eq!(entries[0].plan_name.as_deref(), Some("sanitized:::"));
        assert_eq!(entries[0].unit.as_deref(), Some("token:"));
    }

    #[test]
    fn template_variables_are_escaped_before_evaluation() {
        let vars = ScriptVariables {
            api_key: "key\"; throw new Error('leak');//".to_string(),
            base_url: "https://api.example.test".to_string(),
            ..ScriptVariables::default()
        };
        let script = r#"({
          request: {
            url: "{{baseUrl}}/usage",
            method: "GET",
            headers: { "Authorization": "Bearer {{apiKey}}" }
          },
          extractor: (response) => response
        })"#;
        let request = evaluate_script_request(script, &vars).expect("escaped variables");
        assert_eq!(
            request.headers.get("Authorization").map(String::as_str),
            Some("Bearer key\"; throw new Error('leak');//"),
        );
    }

    #[test]
    fn rendered_script_and_variables_are_bounded() {
        let oversized_variable = ScriptVariables {
            api_key: "x".repeat(MAX_SCRIPT_VARIABLE_BYTES + 1),
            ..ScriptVariables::default()
        };
        assert!(render_script("({ key: \"{{apiKey}}\" })", &oversized_variable).is_err());

        let repeated_placeholders = "{{apiKey}}".repeat(5);
        let expanding_variable = ScriptVariables {
            api_key: "x".repeat(MAX_SCRIPT_VARIABLE_BYTES),
            ..ScriptVariables::default()
        };
        assert!(render_script(&repeated_placeholders, &expanding_variable).is_err());
    }

    #[test]
    fn volcengine_fallback_only_continues_after_soft_failures() {
        assert!(should_try_fallback(QueryFailureKind::Soft));
        assert!(!should_try_fallback(QueryFailureKind::Auth));
        assert!(!should_try_fallback(QueryFailureKind::Transient));

        let auth = json!({
            "ResponseMetadata": {"Error": {"Code": "InvalidSignature", "Message": "bad"}}
        });
        let unsupported = json!({
            "ResponseMetadata": {"Error": {"Code": "UnsupportedPlan", "Message": "none"}}
        });
        assert_eq!(
            classify_volcengine_error(&auth),
            Some(QueryFailureKind::Auth)
        );
        assert_eq!(
            classify_volcengine_error(&unsupported),
            Some(QueryFailureKind::Soft)
        );
    }

    #[test]
    fn volcengine_access_key_errors_are_auth_failures() {
        for code in [
            "InvalidAccessKey",
            "InvalidAccessKeyId",
            "AccessKeyNotFound",
            "AccessKeyDisabled",
        ] {
            let response = json!({
                "ResponseMetadata": {"Error": {"Code": code, "Message": "bad key"}}
            });
            assert_eq!(
                classify_volcengine_error(&response),
                Some(QueryFailureKind::Auth),
                "{code} must hard-stop without fallback",
            );
        }
    }

    #[test]
    fn script_interrupts_unbounded_execution() {
        let started = Instant::now();
        assert!(evaluate_script_request("for (;;) {}", &ScriptVariables::default()).is_err());
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn volcengine_signature_is_deterministic_and_secret_free() {
        let signed = build_volcengine_request(
            "https://ark.cn-beijing.volces.com/api/coding",
            "AKLTtest",
            "secretkey",
            "GetAFPUsage",
            chrono::DateTime::parse_from_rfc3339("2024-06-21T00:00:00Z")
                .unwrap()
                .with_timezone(&chrono::Utc),
        )
        .expect("signed request");
        let authorization = signed
            .headers
            .get("Authorization")
            .expect("authorization header");
        assert_eq!(
            authorization,
            "HMAC-SHA256 Credential=AKLTtest/20240621/cn-beijing/ark/request, SignedHeaders=content-type;host;x-content-sha256;x-date, Signature=de0429a233a6c3e228ec511c8387f09c73654683e5e7ff44dac08f514af28e03",
        );
        assert!(!authorization.contains("secretkey"));
        assert_eq!(
            signed.headers.get("X-Content-Sha256").map(String::as_str),
            Some("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"),
        );
    }

    #[test]
    fn draft_merge_reuses_persisted_secrets_only_when_flagged_configured() {
        let mut persisted = test_provider("newapi", "https://api.example.test/v1").usage_query;
        persisted.api_key = "saved-key".to_string();
        persisted.access_token = "saved-token".to_string();
        persisted.secret_access_key = "saved-secret".to_string();

        // WebUI 草稿:秘密被脱敏为空串 + Configured=true → 沿用已存密钥。
        let mut redacted = test_provider("newapi", "https://api.example.test/v1").usage_query;
        redacted.api_key_configured = true;
        redacted.access_token_configured = true;
        redacted.secret_access_key_configured = true;
        let merged = merge_draft_config(redacted, &persisted);
        assert_eq!(merged.api_key, "saved-key");
        assert_eq!(merged.access_token, "saved-token");
        assert_eq!(merged.secret_access_key, "saved-secret");

        // 显式清空(Configured=false)不得回捡旧密钥;新填值优先。
        let mut cleared = test_provider("newapi", "https://api.example.test/v1").usage_query;
        cleared.access_token = "fresh-token".to_string();
        let merged = merge_draft_config(cleared, &persisted);
        assert_eq!(merged.api_key, "");
        assert_eq!(merged.access_token, "fresh-token");
        assert_eq!(merged.secret_access_key, "");
    }

    #[tokio::test]
    async fn draft_test_runs_editor_config_even_when_usage_query_is_disabled() {
        // 「测试查询」以编辑器草稿为准:已存配置是"未启用 + general",草稿是
        // 自定义脚本——必须按草稿执行并真实发出请求。
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test server");
        let address = listener.local_addr().expect("test server address");
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept test request");
            let mut buffer = [0_u8; 4096];
            let _ = socket.read(&mut buffer).await.expect("read test request");
            let body = r#"{"balance": 7.5}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            socket
                .write_all(response.as_bytes())
                .await
                .expect("write test response");
        });

        let mut provider = test_provider("general", "https://api.example.test/v1");
        provider.usage_query.enabled = false;

        let mut draft = test_provider("custom", "https://api.example.test/v1").usage_query;
        draft.enabled = false;
        draft.script = format!(
            r#"({{
  request: {{ url: "http://{address}/draft", method: "GET" }},
  extractor: function (response) {{
    return {{ remaining: response.balance, unit: "USD" }};
  }}
}})"#
        );

        let result = execute_draft_test(provider, draft).await;
        assert_eq!(result.error, None);
        assert_eq!(result.data[0].remaining, Some(7.5));
        assert!(!result.is_stale);
        server.await.expect("server task");
    }

    fn test_provider(mode: &str, base_url: &str) -> StoredProvider {
        StoredProvider {
            provider_type: "claude_code".to_string(),
            base_url: base_url.to_string(),
            api_key: "provider-secret".to_string(),
            usage_query: UsageQueryConfig {
                enabled: true,
                mode: mode.to_string(),
                base_url: String::new(),
                api_key: String::new(),
                access_token: String::new(),
                user_id: String::new(),
                access_key_id: if base_url.contains("volces.com") {
                    "AKLTtest".to_string()
                } else {
                    String::new()
                },
                secret_access_key: if base_url.contains("volces.com") {
                    "secretkey".to_string()
                } else {
                    String::new()
                },
                script: String::new(),
                coding_plan_provider: String::new(),
                team_organization_id: String::new(),
                team_project_id: String::new(),
                timeout_secs: None,
                api_key_configured: false,
                access_token_configured: false,
                secret_access_key_configured: false,
            },
        }
    }

    #[test]
    fn zhipu_team_plan_routes_by_explicit_selection_with_org_headers() {
        // 与个人版 base_url 相同,靠显式 coding_plan_provider 路由:同路径 +
        // ?type=2 + 组织/项目请求头,Authorization 不加 Bearer(对齐 cc-switch)。
        let mut provider = test_provider("coding-plan", "https://open.bigmodel.cn/api/paas/v4");
        provider.usage_query.coding_plan_provider = "zhipu_team".to_string();
        provider.usage_query.team_organization_id = "org-1".to_string();
        provider.usage_query.team_project_id = "proj-1".to_string();

        let prepared = prepare_query(&provider).expect("prepare zhipu team query");
        assert_eq!(prepared.primary.adapter, ProviderAdapter::Zhipu);
        assert_eq!(
            prepared.primary.request.url.as_str(),
            "https://open.bigmodel.cn/api/monitor/usage/quota/limit?type=2"
        );
        let headers = &prepared.primary.request.headers;
        assert_eq!(
            headers.get("Authorization").map(String::as_str),
            Some("provider-secret"),
        );
        assert_eq!(
            headers.get("bigmodel-organization").map(String::as_str),
            Some("org-1"),
        );
        assert_eq!(
            headers.get("bigmodel-project").map(String::as_str),
            Some("proj-1"),
        );

        // 组织/项目缺一不可。
        let mut missing = provider.clone();
        missing.usage_query.team_project_id = String::new();
        assert!(prepare_query(&missing).is_err());

        // 未显式选择团队版时,同一 base_url 仍走个人版端点(不带 ?type=2)。
        let personal = test_provider("coding-plan", "https://open.bigmodel.cn/api/paas/v4");
        let prepared = prepare_query(&personal).expect("prepare personal zhipu query");
        assert_eq!(
            prepared.primary.request.url.as_str(),
            "https://open.bigmodel.cn/api/monitor/usage/quota/limit"
        );
    }

    #[test]
    fn zenmux_plan_prefers_usage_query_credential_overrides() {
        let mut provider = test_provider("coding-plan", "https://api.other.example/v1");
        provider.usage_query.coding_plan_provider = "zenmux".to_string();
        provider.usage_query.base_url = "https://api.zenmux.com/v1/usage".to_string();
        provider.usage_query.api_key = "zenmux-secret".to_string();

        let prepared = prepare_query(&provider).expect("prepare zenmux query");
        assert_eq!(prepared.primary.adapter, ProviderAdapter::ZenMux);
        assert_eq!(
            prepared.primary.request.url.as_str(),
            "https://api.zenmux.com/v1/usage"
        );
        assert_eq!(
            prepared
                .primary
                .request
                .headers
                .get("Authorization")
                .map(String::as_str),
            Some("Bearer zenmux-secret"),
        );
    }

    #[test]
    fn script_modes_fall_back_to_builtin_presets_when_script_is_empty() {
        // 选了模板但没落脚本的存量配置必须仍可查询。
        let general = test_provider("general", "https://api.example.test/v1");
        let prepared = prepare_query(&general).expect("general preset fallback");
        assert_eq!(
            prepared.primary.request.url.as_str(),
            "https://api.example.test/v1/user/balance"
        );
        assert_eq!(
            prepared
                .primary
                .request
                .headers
                .get("Authorization")
                .map(String::as_str),
            Some("Bearer provider-secret"),
        );
        assert_eq!(
            prepared
                .primary
                .request
                .headers
                .get("User-Agent")
                .map(String::as_str),
            Some("LiveAgent/1.0"),
        );

        let mut newapi = test_provider("newapi", "https://api.example.test/v1");
        newapi.usage_query.access_token = "token".to_string();
        newapi.usage_query.user_id = "42".to_string();
        let prepared = prepare_query(&newapi).expect("newapi preset fallback");
        assert_eq!(
            prepared.primary.request.url.as_str(),
            "https://api.example.test/v1/api/user/self"
        );
        // {{accessToken}}/{{userId}} 必须替换进请求头,不得残留占位符。
        assert_eq!(
            prepared
                .primary
                .request
                .headers
                .get("Authorization")
                .map(String::as_str),
            Some("Bearer token"),
        );
        assert_eq!(
            prepared
                .primary
                .request
                .headers
                .get("New-Api-User")
                .map(String::as_str),
            Some("42"),
        );
        for value in prepared.primary.request.headers.values() {
            assert!(!value.contains("{{"), "unreplaced placeholder in {value}");
        }

        assert!(prepare_query(&test_provider("custom", "https://api.example.test/v1")).is_err());
        assert!(prepare_query(&test_provider("balance-typo", "https://api.example.test")).is_err());
    }

    #[tokio::test]
    async fn general_preset_substitutes_variables_end_to_end() {
        // 全链路实测:预设脚本经 QuickJS 渲染 → Rust 发出 HTTP → 捕获线上请求
        // 字节,证明 {{baseUrl}}/{{apiKey}} 真实替换;extractor 再解析响应。
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test server");
        let address = listener.local_addr().expect("test server address");
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept test request");
            let mut buffer = [0_u8; 4096];
            let read = socket.read(&mut buffer).await.expect("read test request");
            let raw_request = String::from_utf8_lossy(&buffer[..read]).to_string();
            let body = r#"{"balance": 4.2}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            socket
                .write_all(response.as_bytes())
                .await
                .expect("write test response");
            raw_request
        });

        let mut provider = test_provider("general", &format!("http://{address}"));
        provider.usage_query.api_key = "query-secret".to_string();
        let prepared = prepare_query(&provider).expect("prepare general preset");
        let data = execute_prepared_query(&prepared)
            .await
            .expect("general preset query");
        assert_eq!(data[0].remaining, Some(4.2));
        assert_eq!(data[0].is_valid, Some(true));
        assert_eq!(data[0].unit.as_deref(), Some("USD"));

        let raw_request = server.await.expect("server task").to_ascii_lowercase();
        assert!(
            raw_request.starts_with("get /user/balance http/1.1"),
            "unexpected request line: {raw_request}",
        );
        assert!(raw_request.contains("authorization: bearer query-secret"));
        assert!(raw_request.contains("user-agent: liveagent/1.0"));
        assert!(
            !raw_request.contains("{{"),
            "unreplaced placeholder reached the wire"
        );
    }

    #[tokio::test]
    async fn user_style_custom_script_reaches_local_server() {
        // 回归:自定义脚本打 http://localhost 本地服务(硬编码 URL、顶层尾分号、
        // 行内注释、全角字符、可选链/空值合并、extractor 返回数组)必须真实发出
        // 请求并解析回包——复刻用户实测脚本的全部语法特征。
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test server");
        let port = listener.local_addr().expect("test server address").port();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept test request");
            let mut buffer = [0_u8; 4096];
            let read = socket.read(&mut buffer).await.expect("read test request");
            let raw_request = String::from_utf8_lossy(&buffer[..read]).to_string();
            let body = r#"{"ok": true}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            socket
                .write_all(response.as_bytes())
                .await
                .expect("write test response");
            raw_request
        });

        let script = r#"({
  request: {
    url: "http://localhost:3457/account/summary",
    method: "GET",
    headers: {
      Authorization: "Bearer {{apiKey}}",
      "User-Agent": "cc-switch/1.0",
    },
  },

  extractor: function (response) {
    const plans = [];
    const IND = "　　"; // 全角缩进
    const BRANCH = "├─ ";
    const LAST = "└─ ";

    // 余额
    plans.push({
      planName: "余额",
      remaining: response.balance,
      unit: "USD",
      isValid: true,
    });

    // 订阅（总）
    if (response.subscription) {
      plans.push({
        planName: "订阅 ▶",
        total: response.subscription.total_quota,
        used: response.subscription.used_quota,
        remaining: response.subscription.remaining_quota,
        unit: "USD",
        isValid: true,
        extra: `共 ${response.subscription.active_subscription_count ?? response.subscriptions?.length ?? 0} 个订阅`,
      });
    }

    // 子订阅
    const subs = Array.isArray(response.subscriptions)
      ? response.subscriptions
      : [];
    subs.forEach((sub, idx) => {
      const prefix = idx === subs.length - 1 ? LAST : BRANCH;

      const expire = sub.expired_at?.slice(0, 10) ?? "-";
      const resetText = sub.reset_today ? "已重置" : "未重置";

      plans.push({
        planName: `${IND}${prefix}${sub.name}`,
        total: sub.total_quota,
        remaining: sub.remaining_quota,
        used: sub.total_quota - sub.remaining_quota,
        unit: "USD",
        isValid: true,
        extra: `到期：${expire} · 今日：${resetText}`,
      });
    });

    return plans;
  },
});"#
        .replace("http://localhost:3457", &format!("http://localhost:{port}"));

        let mut provider = test_provider("custom", "https://api.example.test/v1");
        provider.usage_query.script = script;
        let prepared = prepare_query(&provider).expect("prepare user custom script");
        let data = execute_prepared_query(&prepared)
            .await
            .expect("user custom script query");
        assert_eq!(data.len(), 1);
        assert_eq!(data[0].plan_name.as_deref(), Some("余额"));
        assert_eq!(data[0].is_valid, Some(true));
        assert_eq!(data[0].unit.as_deref(), Some("USD"));

        let raw_request = server.await.expect("server task").to_ascii_lowercase();
        assert!(
            raw_request.starts_with("get /account/summary http/1.1"),
            "unexpected request line: {raw_request}",
        );
        assert!(raw_request.contains("authorization: bearer provider-secret"));
    }

    #[test]
    fn general_preset_extractor_reads_balance_payload() {
        let entries = extract_script_entries(
            GENERAL_SCRIPT,
            &ScriptVariables::default(),
            &json!({"balance": 12.34}),
        )
        .expect("general extractor");
        assert_eq!(entries[0].remaining, Some(12.34));
        assert_eq!(entries[0].is_valid, Some(true));
        assert_eq!(entries[0].unit.as_deref(), Some("USD"));
    }

    #[test]
    fn newapi_preset_extractor_handles_success_and_failure_payloads() {
        let success = extract_script_entries(
            NEWAPI_SCRIPT,
            &ScriptVariables::default(),
            &json!({
                "success": true,
                "data": {"group": "vip", "quota": 5_000_000, "used_quota": 2_500_000}
            }),
        )
        .expect("newapi success payload");
        assert_eq!(success[0].plan_name.as_deref(), Some("vip"));
        assert_eq!(success[0].remaining, Some(10.0));
        assert_eq!(success[0].used, Some(5.0));
        assert_eq!(success[0].total, Some(15.0));
        assert_eq!(success[0].unit.as_deref(), Some("USD"));

        let failure = extract_script_entries(
            NEWAPI_SCRIPT,
            &ScriptVariables::default(),
            &json!({"success": false, "message": "invalid token"}),
        )
        .expect("newapi failure payload");
        assert_eq!(failure[0].is_valid, Some(false));
        assert_eq!(failure[0].invalid_message.as_deref(), Some("invalid token"));
    }

    #[test]
    fn script_query_prefers_usage_api_key_override() {
        let mut provider = test_provider("general", "https://api.example.test/v1");
        provider.usage_query.api_key = "query-only-secret".to_string();
        let prepared = prepare_query(&provider).expect("prepare with override");
        assert_eq!(
            prepared
                .primary
                .request
                .headers
                .get("Authorization")
                .map(String::as_str),
            Some("Bearer query-only-secret"),
        );
    }

    #[test]
    fn request_timeout_is_clamped_to_sane_bounds() {
        let mut provider = test_provider("general", "https://api.example.test/v1");
        assert_eq!(
            resolve_timeout(&provider.usage_query),
            Duration::from_secs(DEFAULT_REQUEST_TIMEOUT_SECS)
        );
        provider.usage_query.timeout_secs = Some(0.5);
        assert_eq!(
            resolve_timeout(&provider.usage_query),
            Duration::from_secs(MIN_REQUEST_TIMEOUT_SECS)
        );
        provider.usage_query.timeout_secs = Some(9000.0);
        assert_eq!(
            resolve_timeout(&provider.usage_query),
            Duration::from_secs(MAX_REQUEST_TIMEOUT_SECS)
        );
        provider.usage_query.timeout_secs = Some(f64::NAN);
        assert_eq!(
            resolve_timeout(&provider.usage_query),
            Duration::from_secs(DEFAULT_REQUEST_TIMEOUT_SECS)
        );
        provider.usage_query.timeout_secs = Some(25.0);
        assert_eq!(
            resolve_timeout(&provider.usage_query),
            Duration::from_secs(25)
        );
        assert_eq!(
            prepare_query(&provider).expect("prepared").timeout,
            Duration::from_secs(25)
        );
    }

    #[test]
    fn failure_determinism_matches_keep_last_good_policy() {
        // 确定性(清快照):鉴权、非超时/限流类的 4xx、脚本/解析错误。
        assert!(QueryFailure::new(QueryFailureKind::Auth, "auth").deterministic);
        assert!(QueryFailure::new(QueryFailureKind::Soft, "script").deterministic);
        assert!(QueryFailure::http(reqwest::StatusCode::NOT_FOUND, "404").deterministic);
        assert!(QueryFailure::http(reqwest::StatusCode::BAD_REQUEST, "400").deterministic);
        // 瞬时(保留旧值标 isStale):网络、5xx、408/425/429。
        assert!(!QueryFailure::new(QueryFailureKind::Transient, "net").deterministic);
        assert!(!QueryFailure::http(reqwest::StatusCode::REQUEST_TIMEOUT, "408").deterministic);
        assert!(!QueryFailure::http(reqwest::StatusCode::TOO_EARLY, "425").deterministic);
        assert!(!QueryFailure::http(reqwest::StatusCode::TOO_MANY_REQUESTS, "429").deterministic);
        assert!(!QueryFailure::http(reqwest::StatusCode::BAD_GATEWAY, "502").deterministic);
        assert!(
            !QueryFailure::http(reqwest::StatusCode::INTERNAL_SERVER_ERROR, "500").deterministic
        );
    }

    #[tokio::test]
    async fn volcengine_throttling_body_stays_transient_for_keep_last_good() {
        // 429/5xx + 火山错误体(FlowLimitExceeded 等):kind 仍为 Soft(可触发
        // fallback),但确定性必须跟随 HTTP 状态——不得误清 keep-last-good 快照。
        let (url, server) = serve_once(|_| {
            let body = r#"{"ResponseMetadata":{"Error":{"Code":"FlowLimitExceeded","Message":"throttled"}}}"#;
            format!(
                "HTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
        })
        .await;
        let prepared = PreparedRequest {
            request: HttpRequest {
                url,
                method: Method::GET,
                headers: HashMap::new(),
                body: None,
            },
            adapter: ProviderAdapter::VolcengineAfp,
            script: None,
        };

        let failure = execute_prepared_request(&prepared, Duration::from_secs(5))
            .await
            .expect_err("throttled volcengine request must fail");
        assert_eq!(failure.kind, QueryFailureKind::Soft);
        assert!(!failure.deterministic);
        server.await.expect("server task");
    }

    #[test]
    fn stored_provider_without_usage_query_uses_disabled_defaults() {
        let provider: StoredProvider = serde_json::from_value(serde_json::json!({
            "type": "codex",
            "baseUrl": "https://api.example.test/v1",
            "apiKey": "provider-secret"
        }))
        .expect("legacy provider should deserialize");

        assert!(!provider.usage_query.enabled);
        assert!(provider.usage_query.mode.is_empty());

        // 缺新增字段(apiKey/timeoutSecs)的存量 usageQuery JSON 也必须能反序列化。
        let provider: StoredProvider = serde_json::from_value(serde_json::json!({
            "type": "codex",
            "baseUrl": "https://api.example.test/v1",
            "apiKey": "provider-secret",
            "usageQuery": {
                "enabled": true,
                "mode": "general",
                "script": "",
                "baseUrl": "",
                "accessToken": "",
                "userId": "",
                "accessKeyId": "",
                "secretAccessKey": ""
            }
        }))
        .expect("pre-upgrade usage query should deserialize");
        assert!(provider.usage_query.enabled);
        assert!(provider.usage_query.api_key.is_empty());
        assert!(provider.usage_query.timeout_secs.is_none());
    }

    async fn serve_once(
        response: impl FnOnce(std::net::SocketAddr) -> String,
    ) -> (Url, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test server");
        let address = listener.local_addr().expect("test server address");
        let response = response(address);
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept test request");
            let mut request = [0_u8; 1024];
            let _ = socket.read(&mut request).await.expect("read test request");
            socket
                .write_all(response.as_bytes())
                .await
                .expect("write test response");
        });
        (
            Url::parse(&format!("http://{address}/usage")).expect("test server URL"),
            server,
        )
    }
}
