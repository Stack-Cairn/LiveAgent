//! 统一的桌面系统通知入口。
//!
//! 日程提醒、定时任务结果与 Agent `Notify` 都经 [`NotificationService::notify`]：按设置里的
//! 类别开关与节流决定是否调用系统通知。历史记录、免打扰与点击回到应用交给操作系统
//! （通知中心、专注模式 / 勿扰、激活应用），这里不重复实现。

#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const TITLE_MAX_CHARS: usize = 120;
pub const BODY_MAX_CHARS: usize = 500;
/// 前端推送的文案条数与单条长度上限。
const LABELS_MAX: usize = 64;
const LABEL_MAX_CHARS: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotificationKind {
    PlanningReminder,
    CronFailure,
    CronSuccess,
    AgentMessage,
    /// 设置页「发送测试通知」：不受类别开关影响。
    Test,
}

/// 系统设置 `notifications` 键：各类别是否弹系统通知。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NotificationPreferences {
    pub planning: bool,
    pub cron_failure: bool,
    pub cron_success: bool,
    pub agent: bool,
}

impl Default for NotificationPreferences {
    fn default() -> Self {
        Self {
            planning: true,
            cron_failure: true,
            cron_success: false,
            agent: true,
        }
    }
}

impl NotificationPreferences {
    /// 缺失 / 非对象 / 字段类型不对时逐项回退默认值。
    pub fn from_value(raw: Option<&Value>) -> Self {
        let defaults = Self::default();
        let Some(Value::Object(map)) = raw else {
            return defaults;
        };
        let flag =
            |key: &str, fallback: bool| map.get(key).and_then(Value::as_bool).unwrap_or(fallback);
        Self {
            planning: flag("planning", defaults.planning),
            cron_failure: flag("cronFailure", defaults.cron_failure),
            cron_success: flag("cronSuccess", defaults.cron_success),
            agent: flag("agent", defaults.agent),
        }
    }

    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }

    pub fn allows(&self, kind: NotificationKind) -> bool {
        match kind {
            NotificationKind::PlanningReminder => self.planning,
            NotificationKind::CronFailure => self.cron_failure,
            NotificationKind::CronSuccess => self.cron_success,
            NotificationKind::AgentMessage => self.agent,
            NotificationKind::Test => true,
        }
    }
}

#[derive(Debug, Clone)]
pub struct Notice {
    pub kind: NotificationKind,
    pub title: String,
    pub body: String,
    /// 节流键（如某个定时任务）：同键在 `min_interval_ms` 内只弹一次。
    pub throttle: Option<(String, i64)>,
}

impl Notice {
    pub fn new(kind: NotificationKind, title: impl Into<String>, body: impl Into<String>) -> Self {
        Self {
            kind,
            title: title.into(),
            body: body.into(),
            throttle: None,
        }
    }

    pub fn throttled(mut self, key: impl Into<String>, min_interval_ms: i64) -> Self {
        self.throttle = Some((key.into(), min_interval_ms));
        self
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum NotifyOutcome {
    /// 已交给系统（插件只表示已排队，系统是否真正展示取决于用户的系统设置）。
    Sent,
    /// 该类别在设置里关闭。
    Disabled,
    /// 节流窗口内已弹过同键通知。
    Throttled,
    /// `LIVEAGENT_DISABLE_NOTIFICATIONS=1`：测试 / 自动化环境不弹。
    DisabledByEnv,
}

type Sender = dyn Fn(&str, &str) -> Result<(), String> + Send + Sync;

pub struct NotificationService {
    sender: RwLock<Option<Arc<Sender>>>,
    labels: RwLock<HashMap<String, String>>,
    last_sent: Mutex<HashMap<String, i64>>,
    disabled_by_env: bool,
}

impl Default for NotificationService {
    fn default() -> Self {
        Self::new()
    }
}

impl NotificationService {
    pub fn new() -> Self {
        Self {
            sender: RwLock::new(None),
            labels: RwLock::new(HashMap::new()),
            last_sent: Mutex::new(HashMap::new()),
            disabled_by_env: std::env::var("LIVEAGENT_DISABLE_NOTIFICATIONS").as_deref() == Ok("1"),
        }
    }

    /// 接入桌面：经 tauri-plugin-notification 投递。
    pub fn attach(&self, app: tauri::AppHandle) {
        self.set_sender(Arc::new(move |title: &str, body: &str| {
            use tauri_plugin_notification::NotificationExt;
            app.notification()
                .builder()
                .title(title)
                .body(body)
                .show()
                .map_err(|error| error.to_string())
        }));
    }

    pub fn set_sender(&self, sender: Arc<Sender>) {
        if let Ok(mut slot) = self.sender.write() {
            *slot = Some(sender);
        }
    }

    /// 前端按界面语言推送的文案（后端没有自己的语言，与托盘菜单同理）。
    pub fn set_labels(&self, labels: HashMap<String, String>) {
        let labels = labels
            .into_iter()
            .take(LABELS_MAX)
            .map(|(key, text)| (key, text.chars().take(LABEL_MAX_CHARS).collect()))
            .collect();
        if let Ok(mut slot) = self.labels.write() {
            *slot = labels;
        }
    }

    /// 取文案并替换 `{name}` 占位符；未推送时用英文默认值。
    pub fn label(&self, key: &str, fallback: &str, params: &[(&str, &str)]) -> String {
        let template = self
            .labels
            .read()
            .ok()
            .and_then(|labels| labels.get(key).cloned())
            .filter(|text| !text.trim().is_empty())
            .unwrap_or_else(|| fallback.to_string());
        params.iter().fold(template, |text, (name, value)| {
            text.replace(&format!("{{{name}}}"), value)
        })
    }

    /// 按当前系统设置投递。
    pub fn notify(&self, notice: Notice) -> Result<NotifyOutcome, String> {
        let preferences = crate::commands::settings::load_runtime_notification_preferences();
        self.notify_with(&preferences, now_ms(), notice)
    }

    pub fn notify_with(
        &self,
        preferences: &NotificationPreferences,
        now: i64,
        notice: Notice,
    ) -> Result<NotifyOutcome, String> {
        if !preferences.allows(notice.kind) {
            return Ok(NotifyOutcome::Disabled);
        }
        if let Some((key, interval)) = &notice.throttle {
            let last = self
                .last_sent
                .lock()
                .ok()
                .and_then(|sent| sent.get(key).copied());
            if last.is_some_and(|last| now >= last && now - last < *interval) {
                return Ok(NotifyOutcome::Throttled);
            }
        }
        let title = clean(&notice.title, TITLE_MAX_CHARS);
        if title.is_empty() {
            return Err("E:title_required".into());
        }
        let body = clean(&notice.body, BODY_MAX_CHARS);
        let outcome = if self.disabled_by_env {
            NotifyOutcome::DisabledByEnv
        } else {
            let sender = self
                .sender
                .read()
                .ok()
                .and_then(|slot| slot.clone())
                .ok_or("E:unavailable")?;
            sender(&title, &body)?;
            NotifyOutcome::Sent
        };
        if let Some((key, _)) = notice.throttle {
            if let Ok(mut sent) = self.last_sent.lock() {
                sent.insert(key, now);
            }
        }
        Ok(outcome)
    }
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// 去控制字符（换行与制表符变空格）、trim、按字符数截断。
pub fn clean(value: &str, max_chars: usize) -> String {
    let cleaned: String = value
        .chars()
        .map(|ch| if ch == '\n' || ch == '\t' { ' ' } else { ch })
        .filter(|ch| !ch.is_control())
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }
    let mut out: String = trimmed.chars().take(max_chars.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// 打开系统的通知设置：macOS 定位到本应用，Windows 打开通知总页，其它平台不支持。
pub fn open_system_settings(app: &tauri::AppHandle) -> Result<(), String> {
    let url = system_settings_url(&app.config().identifier)?;
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| error.to_string())
}

pub fn system_settings_url(identifier: &str) -> Result<String, String> {
    if cfg!(target_os = "macos") {
        Ok(format!(
            "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id={identifier}"
        ))
    } else if cfg!(target_os = "windows") {
        Ok("ms-settings:notifications".into())
    } else {
        Err("E:unsupported".into())
    }
}
