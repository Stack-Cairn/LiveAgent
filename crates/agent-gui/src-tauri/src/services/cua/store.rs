//! CUA 运行时状态：启用开关、允许的应用名单（白名单 / 黑名单语义）、审计日志。
//!
//! 设计：纯内存 `Arc<Mutex<Inner>>`，启动时由 `lib::run` 装载默认配置。
//! 持久化走前端 localStorage（与 STT / 托盘偏好同源），保持与项目里
//! 「桌面端非关键配置走 localStorage，敏感配置走 SQLite」的约定一致。
//! 审计日志不进 SQLite（成本/收益不匹配），仅在内存保留最近 100 条供 UI
//! 显示「最近操作」。

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

use super::error::CuaError;

/// 编译期确定的平台标签。直接给字符串常量，避免在 trait object 上
/// 调用 `Self::platform_label()` 这种 Sized-bound 关联函数。
const fn platform_label_const() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "macos"
    }
    #[cfg(target_os = "windows")]
    {
        "windows"
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        "linux"
    }
}

/// 把 `DateTime<Utc>` 用 RFC3339 字符串承载，避免引入 chrono 的 `serde` feature。
mod chrono_iso {
    use chrono::{DateTime, Utc};
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(value: &DateTime<Utc>, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&value.to_rfc3339())
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<DateTime<Utc>, D::Error> {
        let s = String::deserialize(d)?;
        DateTime::parse_from_rfc3339(&s)
            .map(|dt| dt.with_timezone(&Utc))
            .map_err(serde::de::Error::custom)
    }
}

const AUDIT_LOG_MAX: usize = 100;

/// 持久化的 CUA 配置。前端写过来什么就原样回写（schema 由前端 TS 类型保证）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CuaRuntimeConfig {
    /// 总开关。`false` 时所有 CUA 命令返回 `Disabled` 错误，前端工具注册表也跳过。
    pub enabled: bool,
    /// 白名单：仅当非空时生效；非空时仅允许列表内的 owner 名通过 `focus_window`
    /// / 输入 / 点击（截屏 / 列举不走名单以便 Agent 自检）。
    /// owner 匹配用 `equals_ignore_ascii_case`，避免大小写差异漏判。
    #[serde(default)]
    pub allowed_owners: Vec<String>,
    /// 最大审计日志条数（默认 100；<=0 视作关闭）。
    #[serde(default = "default_audit_limit")]
    pub audit_log_limit: usize,
    /// 「信任模式」开关：开启后 `group:cua` 工具在前端不再弹审批（用户
    /// 自担风险）。关闭时由 `toolPolicy.ts` 走默认 `ask`。
    /// CUA-reviewer 要求：默认逐次审批，显式 trust 才免审。
    #[serde(default)]
    pub trust_mode: bool,
    /// 当前命令安全模式是否 sandboxOffline。CUA 进程会绕过 sandbox 边界
    /// 起子进程，因此 sandboxOffline 下必须强制 deny 全部 `cua_*` 工具。
    /// 由 Tauri 侧 `cua_set_config` 在写入时按 `system.commandSafetyMode`
    /// 自动设置；前端仅展示。
    #[serde(default)]
    pub sandbox_offline: bool,
}

fn default_audit_limit() -> usize {
    AUDIT_LOG_MAX
}

impl Default for CuaRuntimeConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            allowed_owners: Vec::new(),
            audit_log_limit: AUDIT_LOG_MAX,
            trust_mode: false,
            sandbox_offline: false,
        }
    }
}

/// 单条审计记录。`ok=false` 时附 `error`（结构化 CuaError，
/// 由前端按 locale 翻译；CUA-006）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CuaAuditEntry {
    #[serde(with = "chrono_iso")]
    pub timestamp: DateTime<Utc>,
    pub operation: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<CuaError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CuaStoreSnapshot {
    pub config: CuaRuntimeConfig,
    pub platform: &'static str,
    pub available: bool,
    /// 与 `config.sandboxOffline` 同字段；显式平铺便于 UI 渲染沙箱
    /// 离线指示器时不必走整份 config（CUA-reviewer 要求）。
    #[serde(default)]
    pub sandbox_offline: bool,
    pub recent: Vec<CuaAuditEntry>,
}

#[derive(Debug)]
pub struct CuaStore {
    inner: Mutex<Inner>,
}

#[derive(Debug)]
struct Inner {
    config: CuaRuntimeConfig,
    recent: Vec<CuaAuditEntry>,
}

impl CuaStore {
    pub fn new(config: CuaRuntimeConfig) -> Self {
        Self {
            inner: Mutex::new(Inner {
                config,
                recent: Vec::new(),
            }),
        }
    }

    pub fn snapshot(&self) -> CuaStoreSnapshot {
        let inner = self.inner.lock().expect("cua store poisoned");
        CuaStoreSnapshot {
            config: inner.config.clone(),
            platform: platform_label_const(),
            available: inner.config.enabled,
            sandbox_offline: inner.config.sandbox_offline,
            recent: inner.recent.clone(),
        }
    }

    pub fn replace_config(&self, config: CuaRuntimeConfig) {
        let mut inner = self.inner.lock().expect("cua store poisoned");
        inner.config = config;
    }

    /// 把 store 内的 sandbox_offline 同步到传入值。`cua_status` 每次
    /// 取快照前调用，保证 UI 看到的是当前命令安全模式的最新真值，
    /// 而不是上一次 `cua_set_config` 时写入的陈旧值。
    pub fn refresh_sandbox_offline(&self, sandbox_offline: bool) {
        let mut inner = self.inner.lock().expect("cua store poisoned");
        inner.config.sandbox_offline = sandbox_offline;
    }

    /// 命令执行前调用：返回 ok 或对应的结构化拒绝原因。
    /// 优先级（由粗到细，任一命中即返回）：
    /// 1. 命令安全模式 = sandboxOffline → `CuaError::sandbox_offline()`
    ///    （防止 CUA 子进程突破 sandbox 强制断网）。
    /// 2. 未启用 → `CuaError::disabled()`
    /// 3. 有白名单且 owner 不在表里 → `CuaError::denied_by_allowlist(...)`
    pub fn enforce(
        &self,
        op: &str,
        owner: Option<&str>,
    ) -> Result<(), CuaError> {
        let inner = self.inner.lock().expect("cua store poisoned");
        if inner.config.sandbox_offline {
            return Err(CuaError::sandbox_offline());
        }
        if !inner.config.enabled {
            return Err(CuaError::disabled());
        }
        let allowed_owners = &inner.config.allowed_owners;
        if !allowed_owners.is_empty() {
            let target = match owner {
                Some(o) => o.trim(),
                None => "", // 操作没指定 owner，但名单非空 → 拒绝
            };
            if target.is_empty()
                || !allowed_owners
                    .iter()
                    .any(|a| a.eq_ignore_ascii_case(target))
            {
                let _ = op;
                return Err(CuaError::denied_by_allowlist(target, allowed_owners));
            }
        }
        Ok(())
    }

    /// 把审计条目写入内存。若用户在前端把 `audit_log_limit` 设为 0
    /// （即关闭审计），本方法跳过 push——尊重 UI 「0 = disable」
    /// 文案（CUA-005 修复）。`audit_log_limit > 1000` 截到 1000。
    pub fn record(&self, entry: CuaAuditEntry) {
        let mut inner = self.inner.lock().expect("cua store poisoned");
        let limit = inner.config.audit_log_limit.min(1000);
        if limit == 0 {
            // 用户禁用审计：直接退出，不写入任何条目。
            return;
        }
        inner.recent.push(entry);
        if inner.recent.len() > limit {
            let drop_n = inner.recent.len() - limit;
            inner.recent.drain(0..drop_n);
        }
    }

    pub fn clear_audit(&self) {
        let mut inner = self.inner.lock().expect("cua store poisoned");
        inner.recent.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_config(audit_log_limit: usize, enabled: bool) -> CuaRuntimeConfig {
        CuaRuntimeConfig {
            enabled,
            allowed_owners: Vec::new(),
            audit_log_limit,
            trust_mode: false,
            sandbox_offline: false,
        }
    }

    fn fake_entry(op: &str) -> CuaAuditEntry {
        CuaAuditEntry {
            timestamp: Utc::now(),
            operation: op.to_string(),
            ok: true,
            error: None,
            detail: None,
        }
    }

    /// CUA-005：当 audit_log_limit = 0（用户在 UI 中点 "0 = disable"），
    /// store 应完全跳过 push，确保 recent 始终为空。后续改成 50 时正常
    /// 记录并裁剪到 50 条。
    #[test]
    fn audit_log_zero_means_disabled() {
        let cfg_zero = fake_config(0, false);
        let store = CuaStore::new(cfg_zero);
        for i in 0..5 {
            store.record(fake_entry(&format!("op{i}")));
        }
        assert!(
            store.snapshot().recent.is_empty(),
            "audit_log_limit=0 must drop every entry"
        );

        let mut next_cfg = store.snapshot().config.clone();
        next_cfg.audit_log_limit = 50;
        next_cfg.enabled = true;
        store.replace_config(next_cfg);

        for i in 0..3 {
            store.record(fake_entry(&format!("op{i}")));
        }
        let snap = store.snapshot();
        assert_eq!(snap.recent.len(), 3);
        assert_eq!(snap.recent[0].operation, "op0");
        assert_eq!(snap.recent[2].operation, "op2");
    }

    /// CUA-005 附带：limit=50 时正常裁剪到 50 条。
    #[test]
    fn audit_log_respects_positive_limit() {
        let store = CuaStore::new(fake_config(50, false));
        for i in 0..80 {
            store.record(fake_entry(&format!("op{i}")));
        }
        let snap = store.snapshot();
        assert_eq!(snap.recent.len(), 50);
        // 应丢弃最早的 30 条，剩下 op30..op79。
        assert_eq!(snap.recent[0].operation, "op30");
        assert_eq!(snap.recent[49].operation, "op79");
    }

    /// CUA-005 附带：limit 巨大值（>1000）也会被夹到 1000 上限。
    #[test]
    fn audit_log_caps_huge_limit_at_1000() {
        let store = CuaStore::new(fake_config(usize::MAX, false));
        for i in 0..1500 {
            store.record(fake_entry(&format!("op{i}")));
        }
        let snap = store.snapshot();
        assert_eq!(snap.recent.len(), 1000);
    }

    /// CUA-006：enforce 返回的禁用错误是结构化 CuaError（kind 稳定、
    /// message 是英文），不再泄露中文硬编码字符串。
    #[test]
    fn enforce_returns_structured_error_when_disabled() {
        let store = CuaStore::new(fake_config(100, false));
        let err = store
            .enforce("list_windows", None)
            .expect_err("must reject when disabled");
        assert_eq!(err.kind, "cua.errors.disabled");
        assert!(err.message.contains("CUA"), "fallback message usable: {}", err.message);
        assert!(!err.message.contains('你'), "no Chinese leaks: {}", err.message);
    }

    /// CUA-006：denied_by_allowlist 携带 target + allowed 参数。
    #[test]
    fn enforce_returns_structured_denied_by_allowlist() {
        let mut cfg = fake_config(100, true);
        cfg.allowed_owners = vec!["Finder".into()];
        let store = CuaStore::new(cfg);
        let err = store
            .enforce("click", Some("Safari"))
            .expect_err("must reject Safari");
        assert_eq!(err.kind, "cua.errors.deniedByAllowlist");
        assert_eq!(
            err.params
                .get("target")
                .and_then(|v| v.as_str())
                .map(str::to_owned),
            Some("Safari".into())
        );
        assert!(!err.message.contains('你'));
    }

    /// CUA-reviewer 安全门控：命令安全模式 = sandboxOffline 时，
    /// 即使 enabled=true + 白名单匹配，也必须强制 deny 全部 cua_*，
    /// 防止 CUA 子进程突破 sandbox 的强制断网。
    #[test]
    fn enforce_denies_when_sandbox_offline() {
        let mut cfg = fake_config(100, true);
        cfg.allowed_owners = vec!["Finder".into()];
        cfg.sandbox_offline = true;
        let store = CuaStore::new(cfg);
        let err = store
            .enforce("click", Some("Finder"))
            .expect_err("must reject under sandboxOffline");
        assert_eq!(err.kind, "cua.errors.sandboxOffline");
        // 即使 enabled 关闭也应该 deny，验证优先级：sandboxOffline > disabled。
        let mut cfg2 = fake_config(100, false);
        cfg2.sandbox_offline = true;
        let store2 = CuaStore::new(cfg2);
        assert_eq!(
            store2.enforce("list_windows", None).unwrap_err().kind,
            "cua.errors.sandboxOffline"
        );
        // 关掉 sandboxOffline 后回到 enabled=true 走通。
        let mut cfg3 = fake_config(100, true);
        cfg3.allowed_owners = vec!["Finder".into()];
        let store3 = CuaStore::new(cfg3);
        store3
            .enforce("click", Some("Finder"))
            .expect("must allow when sandboxOffline=false");
    }
}