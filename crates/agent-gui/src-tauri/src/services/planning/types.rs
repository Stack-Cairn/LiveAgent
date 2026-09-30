use serde::{Deserialize, Serialize};
use serde_json::Value;

fn default_priority() -> String {
    "medium".into()
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanningCategory {
    pub id: String,
    pub name: String,
    pub color: String,
    #[serde(default)]
    pub sort_order: i64,
    pub revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Calendar {
    pub id: String,
    pub name: String,
    pub color: String,
    pub sort_order: i64,
    pub is_default: bool,
    #[serde(default = "default_reminder")]
    pub reminder_minutes: Option<i64>,
    #[serde(default = "local_source")]
    pub source_kind: String,
    #[serde(default)]
    pub read_only: bool,
    #[serde(default)]
    pub external_id: Option<String>,
    pub revision: u64,
}
fn default_reminder() -> Option<i64> {
    Some(0)
}
fn local_source() -> String {
    "local".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Todo {
    #[serde(default)]
    pub sort_order: i64,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub deleted_at: Option<i64>,
    #[serde(default)]
    pub group_id: Option<String>,
    #[serde(default)]
    pub tag_ids: Vec<String>,
    #[serde(default = "default_priority")]
    pub priority: String,
    #[serde(default)]
    pub reminder_minutes: i64,
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub notes: String,
    pub status: String,
    /// Pre-release builds could bind a project; accepted when reading old data, never written.
    #[serde(default, rename = "projectId", skip_serializing)]
    #[allow(dead_code)]
    pub legacy_project_id: Option<serde_json::Value>,
    #[serde(default)]
    pub estimate_minutes: Option<i64>,
    #[serde(default)]
    pub due_at: Option<i64>,
    #[serde(default)]
    pub due_date: Option<String>,
    #[serde(default)]
    pub due_time_zone: Option<String>,
    #[serde(default)]
    pub due_reminder: bool,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub completed_at: Option<i64>,
    pub revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum EventTime {
    #[serde(rename_all = "camelCase")]
    Timed {
        start_at: i64,
        end_at: i64,
        time_zone: String,
    },
    #[serde(rename_all = "camelCase")]
    AllDay {
        start_date: String,
        end_date_exclusive: String,
        time_zone: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Recurrence {
    pub frequency: String,
    pub interval: u32,
    #[serde(default)]
    pub weekdays: Vec<u32>,
    #[serde(default)]
    pub count: Option<u32>,
    #[serde(default)]
    pub until: Option<String>,
    #[serde(default)]
    pub excluded_dates: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Event {
    #[serde(default)]
    pub deleted_at: Option<i64>,
    #[serde(default)]
    pub tag_ids: Vec<String>,
    pub id: String,
    pub calendar_id: String,
    #[serde(default)]
    pub todo_id: Option<String>,
    pub title: String,
    #[serde(default)]
    pub title_override: Option<String>,
    #[serde(default)]
    pub notes: String,
    pub time: EventTime,
    #[serde(default)]
    pub recurrence: Option<Recurrence>,
    #[serde(default)]
    pub series_id: Option<String>,
    #[serde(default)]
    pub original_date: Option<String>,
    /// Google-style per-event notification: absent follows the calendar default,
    /// `-1` turns notifications off, otherwise minutes before the start.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reminder_minutes: Option<i64>,
    pub revision: u64,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Sentinel for an event that opted out of its calendar's default notification.
pub const EVENT_REMINDER_OFF: i64 = -1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Reminder {
    pub id: String,
    pub target_type: String,
    pub target_id: String,
    pub title: String,
    pub origin: String,
    pub trigger_at: i64,
    #[serde(default)]
    pub snoozed_until: Option<i64>,
    pub status: String,
    #[serde(default)]
    pub notified_at: Option<i64>,
    #[serde(default)]
    pub lease_until: Option<i64>,
    #[serde(default)]
    pub attempts: u32,
    #[serde(default)]
    pub next_attempt_at: i64,
    pub revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceLink {
    pub id: String,
    pub target_type: String,
    pub target_id: String,
    pub provider_kind: String,
    pub account_id: Option<String>,
    pub external_id: String,
    pub title: String,
    pub revision: u64,
}

/// Public state of an iCal subscription; the URL itself never leaves the backend.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionStatus {
    pub calendar_id: String,
    pub host: String,
    pub refresh_minutes: i64,
    pub next_at: i64,
    pub last_synced_at: Option<i64>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    pub seq: u64,
    pub time_zone: String,
    pub calendars: Vec<Calendar>,
    pub todos: Vec<Todo>,
    #[serde(default)]
    pub groups: Vec<PlanningCategory>,
    #[serde(default)]
    pub tags: Vec<PlanningCategory>,
    pub events: Vec<Event>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub event_masters: Vec<Event>,
    #[serde(default)]
    pub todo_schedules: Vec<TodoSchedule>,
    pub reminders: Vec<Reminder>,
    /// Pre-release backups carried Agent conversation links; accepted on import and dropped.
    #[serde(default, rename = "links", skip_serializing)]
    #[allow(dead_code)]
    pub legacy_links: Vec<serde_json::Value>,
    pub sources: Vec<SourceLink>,
    /// Derived from `planning_subscriptions`; ignored when importing a backup.
    #[serde(default)]
    pub subscriptions: Vec<SubscriptionStatus>,
    /// Set once the built-in "My Tasks" list is deleted: list-less tasks land in this list.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_group_id: Option<String>,
    /// Color of the built-in "My Tasks" list; other lists keep their color on the group.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub my_tasks_color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Query {
    pub from: Option<i64>,
    pub to: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Mutation {
    pub request_id: String,
    pub action: String,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub expected_revision: Option<u64>,
    #[serde(default)]
    pub data: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationResult {
    pub status: String,
    pub seq: u64,
    pub item: Option<Value>,
    pub replayed: bool,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TodoSchedule {
    pub todo_id: String,
    pub count: usize,
    pub minutes: i64,
    pub has_future: bool,
}
