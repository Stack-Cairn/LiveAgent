use super::{time, types::*};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::Duration;
use uuid::Uuid;

pub struct PlanningStore {
    pub(crate) conn: Mutex<Connection>,
}
pub(super) fn sql_error(e: impl std::fmt::Display) -> String {
    format!("E:storage_failed:{e}")
}
/// 读-改-写事务一律以 IMMEDIATE 开始：一开始就拿写锁，冲突时按 busy_timeout 等待。
/// DEFERRED 事务先读后写时，若期间别的连接（通知服务、定时任务等共用 config.sqlite）
/// 已提交，WAL 下会立即返回 SQLITE_BUSY_SNAPSHOT（「database is locked」），不经过
/// busy_timeout。错误里附带扩展码，便于区分快照过期（517）与写锁被长时间占用（5）。
fn begin_write(conn: &mut Connection) -> Result<Transaction<'_>, String> {
    conn.transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| match &error {
            rusqlite::Error::SqliteFailure(code, _) => {
                format!("E:storage_failed:{error} (code {})", code.extended_code)
            }
            _ => sql_error(error),
        })
}
fn id() -> String {
    Uuid::new_v4().to_string()
}
pub fn now() -> i64 {
    Utc::now().timestamp_millis()
}

const TABLES: [&str; 8] = [
    "calendars",
    "todos",
    "events",
    "reminders",
    "sources",
    "native_bindings",
    "groups",
    "tags",
];

fn read<T: DeserializeOwned>(conn: &Connection, table: &str) -> Result<Vec<T>, String> {
    assert!(TABLES.contains(&table));
    let mut stmt = conn
        .prepare(&format!("SELECT payload FROM planning_{table} ORDER BY id"))
        .map_err(sql_error)?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(sql_error)?;
    rows.map(|r| serde_json::from_str(&r.map_err(sql_error)?).map_err(sql_error))
        .collect()
}
fn save<T: Serialize>(conn: &Connection, table: &str, items: &[T]) -> Result<(), String> {
    assert!(TABLES.contains(&table));
    let old: Vec<Value> = read(conn, table)?;
    let values: Vec<Value> = items
        .iter()
        .map(serde_json::to_value)
        .collect::<Result<_, _>>()
        .map_err(sql_error)?;
    for value in &values {
        let key = value["id"].as_str().ok_or("E:object_id_missing")?;
        if old.iter().any(|item| item == value) {
            continue;
        }
        conn.execute(&format!("INSERT INTO planning_{table}(id,payload) VALUES (?1,?2) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload"), params![key, value.to_string()]).map_err(sql_error)?;
    }
    for value in old {
        if !values.iter().any(|v| v["id"] == value["id"]) {
            conn.execute(
                &format!("DELETE FROM planning_{table} WHERE id=?1"),
                [value["id"].as_str().ok_or("E:object_id_missing")?],
            )
            .map_err(sql_error)?;
        }
    }
    Ok(())
}
fn meta(conn: &Connection, key: &str) -> Result<String, String> {
    conn.query_row("SELECT value FROM planning_meta WHERE key=?1", [key], |r| {
        r.get(0)
    })
    .map_err(sql_error)
}
pub(super) fn snapshot(conn: &Connection) -> Result<Snapshot, String> {
    Ok(Snapshot {
        seq: meta(conn, "seq")?.parse().map_err(sql_error)?,
        // 全局默认时区为唯一来源;meta 中的 timeZone 仅由 persist 镜像写入。
        time_zone: super::time::default_zone(),
        calendars: read(conn, "calendars")?,
        todos: read(conn, "todos")?,
        groups: read(conn, "groups")?,
        tags: read(conn, "tags")?,
        events: read(conn, "events")?,
        event_masters: vec![],
        todo_schedules: vec![],
        reminders: read(conn, "reminders")?,
        legacy_links: vec![],
        sources: read(conn, "sources")?,
        subscriptions: super::subscription::statuses(conn)?,
        default_group_id: conn
            .query_row(
                "SELECT value FROM planning_meta WHERE key='defaultGroupId'",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(sql_error)?,
        my_tasks_color: conn
            .query_row(
                "SELECT value FROM planning_meta WHERE key='myTasksColor'",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(sql_error)?,
    })
}
pub(super) fn persist(conn: &Connection, s: &Snapshot) -> Result<(), String> {
    save(conn, "groups", &s.groups)?;
    save(conn, "tags", &s.tags)?;
    save(conn, "calendars", &s.calendars)?;
    save(conn, "todos", &s.todos)?;
    save(conn, "events", &s.events)?;
    save(conn, "reminders", &s.reminders)?;
    save(conn, "sources", &s.sources)?;
    conn.execute(
        "UPDATE planning_meta SET value=?1 WHERE key='seq'",
        [s.seq.to_string()],
    )
    .map_err(sql_error)?;
    conn.execute(
        "UPDATE planning_meta SET value=?1 WHERE key='timeZone'",
        [&s.time_zone],
    )
    .map_err(sql_error)?;
    match &s.default_group_id {
        Some(id) => conn.execute(
            "INSERT OR REPLACE INTO planning_meta VALUES('defaultGroupId',?1)",
            [id],
        ),
        None => conn.execute("DELETE FROM planning_meta WHERE key='defaultGroupId'", []),
    }
    .map_err(sql_error)?;
    match &s.my_tasks_color {
        Some(color) => conn.execute(
            "INSERT OR REPLACE INTO planning_meta VALUES('myTasksColor',?1)",
            [color],
        ),
        None => conn.execute("DELETE FROM planning_meta WHERE key='myTasksColor'", []),
    }
    .map_err(sql_error)?;
    Ok(())
}
/// Calendar, list and tag colors are `#RRGGBB`; the UI and the Agent both go through here.
pub(super) fn valid_color(value: &Value) -> Result<(), String> {
    match value {
        Value::Null => Ok(()),
        Value::String(v)
            if v.len() == 7
                && v.starts_with('#')
                && v[1..].chars().all(|c| c.is_ascii_hexdigit()) =>
        {
            Ok(())
        }
        _ => Err("E:invalid_color".into()),
    }
}
pub(super) fn data<T: DeserializeOwned>(value: Value) -> Result<T, String> {
    serde_json::from_value(value).map_err(|e| format!("E:invalid_params:{e}"))
}
fn required<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value[key]
        .as_str()
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| format!("E:field_required:{key}"))
}
fn patch<T: Serialize + DeserializeOwned>(
    old: &T,
    updates: &Value,
    allowed: &[&str],
) -> Result<T, String> {
    let mut value = serde_json::to_value(old).map_err(sql_error)?;
    let map = updates.as_object().ok_or("E:update_not_object")?;
    for (key, v) in map {
        if !allowed.contains(&key.as_str()) {
            return Err(format!("E:field_immutable:{key}"));
        }
        value[key] = v.clone();
    }
    data(value)
}
fn title(value: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.chars().count() > 500 {
        Err("E:title_length".into())
    } else {
        Ok(())
    }
}
pub(super) fn writable(s: &Snapshot, calendar: &str) -> Result<(), String> {
    let cal = s
        .calendars
        .iter()
        .find(|c| c.id == calendar)
        .ok_or("E:calendar_missing")?;
    if cal.read_only {
        return Err("E:calendar_read_only".into());
    }
    Ok(())
}

impl PlanningStore {
    pub fn open() -> Result<Self, String> {
        Self::with_connection(
            Connection::open(crate::commands::settings::config_db_path()?).map_err(sql_error)?,
        )
    }
    pub fn with_connection(mut conn: Connection) -> Result<Self, String> {
        conn.busy_timeout(Duration::from_secs(5))
            .map_err(sql_error)?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS planning_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);").map_err(sql_error)?;
        let version: Option<String> = conn
            .query_row(
                "SELECT value FROM planning_meta WHERE key='schema'",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(sql_error)?;
        if version.as_deref().is_some_and(|v| v != "1") {
            return Err("E:data_version_newer".into());
        }
        let tx = begin_write(&mut conn)?;
        for table in TABLES {
            tx.execute_batch(&format!("CREATE TABLE IF NOT EXISTS planning_{table}(id TEXT PRIMARY KEY,payload TEXT NOT NULL CHECK(json_valid(payload))); ")).map_err(sql_error)?;
        }
        tx.execute_batch("CREATE TABLE IF NOT EXISTS planning_requests(id TEXT PRIMARY KEY, request TEXT NOT NULL, result TEXT NOT NULL,created_at INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS planning_event_start ON planning_events(json_extract(payload,'$.time.startAt'));
            CREATE INDEX IF NOT EXISTS planning_event_todo ON planning_events(json_extract(payload,'$.todoId'));
            CREATE INDEX IF NOT EXISTS planning_reminder_due ON planning_reminders(json_extract(payload,'$.triggerAt'));
            INSERT OR IGNORE INTO planning_meta VALUES('schema','1'); INSERT OR IGNORE INTO planning_meta VALUES('seq','0');").map_err(sql_error)?;
        super::subscription::create_table(&tx)?;
        let tz = super::time::default_zone();
        tx.execute(
            "INSERT OR IGNORE INTO planning_meta VALUES('timeZone',?1)",
            [tz],
        )
        .map_err(sql_error)?;
        if read::<Calendar>(&tx, "calendars")?.is_empty() {
            save(
                &tx,
                "calendars",
                &[
                    Calendar {
                        id: id(),
                        name: "工作".into(),
                        color: "#2563eb".into(),
                        sort_order: 0,
                        is_default: true,
                        reminder_minutes: Some(0),
                        source_kind: "local".into(),
                        read_only: false,
                        external_id: None,
                        revision: 1,
                    },
                    Calendar {
                        id: id(),
                        name: "个人".into(),
                        color: "#0f766e".into(),
                        sort_order: 1,
                        is_default: false,
                        reminder_minutes: Some(0),
                        source_kind: "local".into(),
                        read_only: false,
                        external_id: None,
                        revision: 1,
                    },
                ],
            )?;
        }
        tx.commit().map_err(sql_error)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn snapshot(&self, query: Query) -> Result<Snapshot, String> {
        let conn = self.conn.lock().map_err(sql_error)?;
        let mut s = snapshot(&conn)?;
        s.calendars.sort_by_key(|c| c.sort_order);
        s.groups.sort_by_key(|c| c.sort_order);
        s.tags.sort_by_key(|c| c.sort_order);
        let at = now();
        for todo in &s.todos {
            let mut summary = TodoSchedule {
                todo_id: todo.id.clone(),
                count: 0,
                minutes: 0,
                has_future: false,
            };
            for event in s.events.iter().filter(|e| {
                e.todo_id.as_deref() == Some(&todo.id) && super::trash::event_active(&s, e)
            }) {
                let (start, end) = time::bounds(&event.time)?;
                summary.count += 1;
                summary.minutes += (end - start) / 60_000;
                summary.has_future |= if event.recurrence.is_some() {
                    time::next_occurrence(event, at)?.is_some()
                } else {
                    end > at
                };
            }
            s.todo_schedules.push(summary);
        }
        match (query.from, query.to) {
            (Some(from), Some(to)) if to > from && to - from <= 367 * 86_400_000 => {
                s.event_masters = s.events.clone();
                s.events = s
                    .events
                    .iter()
                    .filter(|e| super::trash::event_active(&s, e))
                    .map(|e| time::occurrences(e, from, to))
                    .collect::<Result<Vec<_>, _>>()?
                    .into_iter()
                    .flatten()
                    .collect();
            }
            (None, None) => {}
            _ => return Err("E:query_range".into()),
        }
        Ok(s)
    }

    pub fn mutate(&self, input: Mutation) -> Result<MutationResult, String> {
        // 时区改由「设置 → 通用 → 默认时区」统一管理;旧客户端的写入得到稳定错误码。
        if input.action == "timezone.set" {
            return Err("E:timezone_global".into());
        }
        if input.request_id.len() < 8 || input.request_id.len() > 128 {
            return Err("E:request_id_invalid".into());
        }
        let raw = serde_json::to_string(&input).map_err(sql_error)?;
        if raw.len() > 256_000 {
            return Err("E:request_too_large".into());
        }
        let mut conn = self.conn.lock().map_err(sql_error)?;
        let tx = begin_write(&mut conn)?;
        let existing: Option<(String, String)> = tx
            .query_row(
                "SELECT request,result FROM planning_requests WHERE id=?1",
                [&input.request_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(sql_error)?;
        if let Some((request, result)) = existing {
            if request != raw {
                return Err("E:request_id_reused".into());
            }
            let mut response: MutationResult = serde_json::from_str(&result).map_err(sql_error)?;
            response.replayed = true;
            return Ok(response);
        }
        let mut s = snapshot(&tx)?;
        let current = lookup(&s, &input)?;
        if let Some(value) = &current {
            if input.expected_revision != value["revision"].as_u64() {
                return Ok(MutationResult {
                    status: "conflict".into(),
                    seq: s.seq,
                    item: current,
                    replayed: false,
                    message: Some("E:conflict".into()),
                });
            }
        }
        let now = now();
        let item = apply(&mut s, &input, now)?;
        if input.action == "reminder.create"
            && !target_exists(
                &s,
                input.data["targetType"].as_str().unwrap_or(""),
                input.data["targetId"].as_str().unwrap_or(""),
            )
        {
            return Err("E:reminder_target_missing".into());
        }
        s.reminders
            .retain(|r| target_exists_parts(&s.todos, &s.events, &r.target_type, &r.target_id));
        validate(&s)?;
        reconcile_reminders(&mut s, now, false)?;
        s.seq += 1;
        persist(&tx, &s)?;
        let response = MutationResult {
            status: "ok".into(),
            seq: s.seq,
            item,
            replayed: false,
            message: None,
        };
        tx.execute(
            "INSERT INTO planning_requests VALUES(?1,?2,?3,?4)",
            params![
                input.request_id,
                raw,
                serde_json::to_string(&response).map_err(sql_error)?,
                now
            ],
        )
        .map_err(sql_error)?;
        // 幂等记录保留 30 天，客户端超出有效窗口不得自动重放写入。
        tx.execute(
            "DELETE FROM planning_requests WHERE created_at<?1",
            [now - 30 * 86_400_000],
        )
        .map_err(sql_error)?;
        tx.commit().map_err(sql_error)?;
        Ok(response)
    }

    /// 全局默认时区变化后调用:若镜像时区与当前有效时区不同,按新时区重算日期截止
    /// 提醒并推进 seq,返回新 seq 供调用方广播 `planning:changed`;未变化返回 None。
    pub fn sync_default_zone(&self, now: i64) -> Result<Option<u64>, String> {
        let mut conn = self.conn.lock().map_err(sql_error)?;
        let tx = begin_write(&mut conn)?;
        let mirrored = meta(&tx, "timeZone")?;
        let mut s = snapshot(&tx)?;
        if mirrored == s.time_zone {
            return Ok(None);
        }
        reconcile_reminders(&mut s, now, false)?;
        s.seq += 1;
        persist(&tx, &s)?;
        tx.commit().map_err(sql_error)?;
        Ok(Some(s.seq))
    }

    pub fn claim_reminders(&self, at: i64) -> Result<Vec<Reminder>, String> {
        let mut conn = self.conn.lock().map_err(sql_error)?;
        let tx = begin_write(&mut conn)?;
        let mut s = snapshot(&tx)?;
        let before_reminders = json!(s.reminders);
        reconcile_reminders(&mut s, at, true)?;
        let mut claimed = vec![];
        for r in &mut s.reminders {
            if claimed.len() >= 25 {
                break;
            }
            if r.status == "pending"
                && r.snoozed_until.unwrap_or(r.trigger_at) <= at
                && r.notified_at.is_none()
                && r.lease_until.unwrap_or(0) <= at
                && r.next_attempt_at <= at
                && r.attempts < 5
            {
                r.lease_until = Some(at + 60_000);
                r.attempts += 1;
                r.revision += 1;
                claimed.push(r.clone());
            }
        }
        if json!(s.reminders) != before_reminders {
            s.seq += 1;
        }
        persist(&tx, &s)?;
        tx.commit().map_err(sql_error)?;
        Ok(claimed)
    }
    pub fn finish_notification(
        &self,
        reminder: &Reminder,
        success: bool,
        at: i64,
    ) -> Result<(), String> {
        let mut conn = self.conn.lock().map_err(sql_error)?;
        let tx = begin_write(&mut conn)?;
        let mut s = snapshot(&tx)?;
        if let Some(r) = s
            .reminders
            .iter_mut()
            .find(|r| r.id == reminder.id && r.revision == reminder.revision)
        {
            r.lease_until = None;
            r.revision += 1;
            if success {
                r.notified_at = Some(at);
            } else {
                r.next_attempt_at = at + 60_000 * i64::from(r.attempts);
            }
            s.seq += 1;
            persist(&tx, &s)?;
        }
        tx.commit().map_err(sql_error)
    }
    pub fn export(&self) -> Result<Snapshot, String> {
        self.snapshot(Query::default())
    }
    pub fn import(&self, mut incoming: Snapshot) -> Result<(), String> {
        validate(&incoming)?;
        let mut conn = self.conn.lock().map_err(sql_error)?;
        let tx = begin_write(&mut conn)?;
        let old = snapshot(&tx)?;
        incoming.seq = old.seq + 1;
        incoming.event_masters.clear();
        incoming.todo_schedules.clear();
        // 导入是显式替换，抬升版本以使旧客户端草稿失效；不重播系统通知。
        for t in &mut incoming.todos {
            t.revision = old
                .todos
                .iter()
                .find(|o| o.id == t.id)
                .map_or(t.revision + 1, |o| o.revision.max(t.revision) + 1);
        }
        for e in &mut incoming.events {
            e.revision = old
                .events
                .iter()
                .find(|o| o.id == e.id)
                .map_or(e.revision + 1, |o| o.revision.max(e.revision) + 1);
        }
        for c in &mut incoming.calendars {
            c.revision = old
                .calendars
                .iter()
                .find(|o| o.id == c.id)
                .map_or(c.revision + 1, |o| o.revision.max(c.revision) + 1);
        }
        for (items, previous) in [
            (&mut incoming.groups, &old.groups),
            (&mut incoming.tags, &old.tags),
        ] {
            for item in items {
                item.revision = previous
                    .iter()
                    .find(|v| v.id == item.id)
                    .map_or(item.revision + 1, |v| v.revision.max(item.revision) + 1);
            }
        }
        for r in &mut incoming.reminders {
            r.lease_until = None;
            r.notified_at = Some(now());
            r.revision += 1;
        }
        persist(&tx, &incoming)?;
        tx.execute("DELETE FROM planning_requests", [])
            .map_err(sql_error)?;
        tx.commit().map_err(sql_error)
    }
}

fn lookup(s: &Snapshot, input: &Mutation) -> Result<Option<Value>, String> {
    let action = input.action.as_str();
    if action.ends_with(".create")
        || ["todo.import", "mytasks.delete", "mytasks.update"].contains(&action)
    {
        return Ok(None);
    }
    let key = input.id.as_deref().ok_or("E:field_required:id")?;
    let found = match action.split('.').next().unwrap_or("") {
        "calendar" => s
            .calendars
            .iter()
            .find(|v| v.id == key)
            .map(serde_json::to_value),
        "group" => s
            .groups
            .iter()
            .find(|v| v.id == key)
            .map(serde_json::to_value),
        "tag" => s
            .tags
            .iter()
            .find(|v| v.id == key)
            .map(serde_json::to_value),
        "todo" => s
            .todos
            .iter()
            .find(|v| v.id == key)
            .map(serde_json::to_value),
        "event" => s
            .events
            .iter()
            .find(|v| v.id == key)
            .map(serde_json::to_value),
        "reminder" => s
            .reminders
            .iter()
            .find(|v| v.id == key)
            .map(serde_json::to_value),
        "source" => s
            .sources
            .iter()
            .find(|v| v.id == key)
            .map(serde_json::to_value),
        _ => return Err("E:unknown_action".into()),
    };
    found
        .ok_or_else(|| "E:item_missing".to_string())?
        .map(Some)
        .map_err(sql_error)
}

/// After "My Tasks" is deleted, a missing list means the default list.
fn default_list_input(s: &Snapshot, m: &Mutation) -> Option<Mutation> {
    let group = s.default_group_id.as_ref()?;
    let explicit_none = m.data.get("groupId").is_some_and(Value::is_null);
    let implicit = m.action == "todo.create" && m.data.get("groupId").is_none();
    if !m.data.is_object()
        || !["todo.create", "todo.update", "todo.move"].contains(&m.action.as_str())
        || !(explicit_none || implicit)
    {
        return None;
    }
    let mut m = m.clone();
    m.data["groupId"] = json!(group);
    Some(m)
}

fn apply(s: &mut Snapshot, m: &Mutation, now: i64) -> Result<Option<Value>, String> {
    let normalized = default_list_input(s, m);
    let m = normalized.as_ref().unwrap_or(m);
    let key = m.id.as_deref().unwrap_or("");
    let d = &m.data;
    if [
        "todo.delete",
        "todo.restore",
        "event.delete",
        "event.restore",
    ]
    .contains(&m.action.as_str())
    {
        return super::trash::apply(s, m, now);
    }
    if m.action == "calendar.import" {
        return super::calendar_import::apply(s, m, now);
    }
    if m.action == "todo.import" {
        return super::task_import::apply(s, m, now);
    }
    if m.action.starts_with("todo.")
        && m.action != "todo.purge"
        && s.todos
            .iter()
            .any(|t| t.id == key && t.deleted_at.is_some())
    {
        return Err("E:restore_task_first".into());
    }
    if m.action.starts_with("event.")
        && m.action != "event.purge"
        && s.events
            .iter()
            .any(|e| e.id == key && !super::trash::event_active(s, e))
    {
        return Err("E:restore_event_first".into());
    }
    let fields: &[&str] = match m.action.as_str() {
        "group.create" | "tag.create" | "group.update" | "tag.update" => {
            &["name", "color", "sortOrder"]
        }
        "group.delete" | "tag.delete" => &[],
        "mytasks.delete" => &["defaultGroupId", "deleteTasks"],
        "mytasks.update" => &["color"],
        "calendar.create" => &["name", "color"],
        "calendar.update" => &["name", "color", "sortOrder", "isDefault", "reminderMinutes"],
        "calendar.delete" => &["moveTo"],
        "todo.create" => &[
            "schedule",
            "title",
            "notes",
            "estimateMinutes",
            "dueAt",
            "dueDate",
            "dueTimeZone",
            "dueReminder",
            "groupId",
            "parentId",
            "tagIds",
            "priority",
            "reminderMinutes",
        ],
        "todo.update" => &[
            "title",
            "notes",
            "estimateMinutes",
            "dueAt",
            "dueDate",
            "dueTimeZone",
            "dueReminder",
            "groupId",
            "parentId",
            "tagIds",
            "priority",
            "reminderMinutes",
            "status",
        ],
        "todo.move" => &[
            "parentId",
            "groupId",
            "beforeId",
            "afterId",
            "relativeRevision",
        ],
        "todo.schedule" => &["calendarId", "time", "title", "notes"],
        "event.create" | "event.update" => &[
            "calendarId",
            "todoId",
            "title",
            "titleOverride",
            "notes",
            "time",
            "recurrence",
            "tagIds",
            "reminderMinutes",
        ],
        "event.exception" => &["date", "delete", "time", "title", "notes"],
        "event.split" => &[
            "date",
            "delete",
            "calendarId",
            "title",
            "notes",
            "time",
            "recurrence",
            "reminderMinutes",
        ],
        "event.restoreException" => &["date", "exceptionId", "exceptionRevision"],
        "reminder.create" => &["targetType", "targetId", "triggerAt"],
        "reminder.snooze" => &["minutes"],
        "source.create" => &[
            "targetType",
            "targetId",
            "providerKind",
            "accountId",
            "externalId",
            "title",
        ],
        "todo.purge" | "event.purge" | "reminder.delete" | "reminder.acknowledge" => &[],
        _ => return Err("E:unknown_action".into()),
    };
    for field in d.as_object().ok_or("E:data_not_object")?.keys() {
        if !fields.contains(&field.as_str()) {
            return Err(format!("E:unknown_field:{field}"));
        }
    }
    if d.get("color").is_some() {
        valid_color(&d["color"])?;
    }
    let mut result = None;
    match m.action.as_str() {
        "group.create" | "tag.create" => {
            let list = if m.action.starts_with("group") {
                &mut s.groups
            } else {
                &mut s.tags
            };
            let c: PlanningCategory = data(
                json!({"id":id(),"name":required(d,"name")?,"color":d["color"].as_str().unwrap_or("#64748b"),"sortOrder":d["sortOrder"].as_i64().unwrap_or(list.len() as i64),"revision":1}),
            )?;
            result = Some(json!(c));
            list.push(c);
        }
        "group.update" | "tag.update" => {
            let list = if m.action.starts_with("group") {
                &mut s.groups
            } else {
                &mut s.tags
            };
            let c = list
                .iter_mut()
                .find(|c| c.id == key)
                .ok_or("E:category_missing")?;
            *c = patch(c, d, &["name", "color", "sortOrder"])?;
            c.revision += 1;
            result = Some(json!(c));
        }
        "group.delete" => {
            s.groups.retain(|c| c.id != key);
            // Tasks fall back to the default list; deleting the default list brings back My Tasks.
            if s.default_group_id.as_deref() == Some(key) {
                s.default_group_id = None;
            }
            let fallback = s.default_group_id.clone();
            for t in &mut s.todos {
                if t.group_id.as_deref() == Some(key) {
                    t.group_id = fallback.clone();
                    t.revision += 1;
                    t.updated_at = now;
                }
            }
        }
        "tag.delete" => {
            s.tags.retain(|c| c.id != key);
            for t in &mut s.todos {
                if t.tag_ids.iter().any(|id| id == key) {
                    t.tag_ids.retain(|id| id != key);
                    t.revision += 1;
                    t.updated_at = now;
                }
            }
            for e in &mut s.events {
                if e.tag_ids.iter().any(|id| id == key) {
                    e.tag_ids.retain(|id| id != key);
                    e.revision += 1;
                    e.updated_at = now;
                }
            }
        }
        "mytasks.update" => {
            if s.default_group_id.is_some() {
                return Err("E:my_tasks_deleted".into());
            }
            s.my_tasks_color = d["color"].as_str().map(str::to_string);
        }
        "mytasks.delete" => {
            if s.default_group_id.is_some() {
                return Err("E:my_tasks_deleted".into());
            }
            let target = required(d, "defaultGroupId")?.to_string();
            if !s.groups.iter().any(|g| g.id == target) {
                return Err("E:category_missing".into());
            }
            let trash = match &d["deleteTasks"] {
                Value::Null => false,
                Value::Bool(v) => *v,
                _ => return Err("E:invalid_params:deleteTasks".into()),
            };
            // Tasks keep their hierarchy: the whole list moves, and is recycled when requested.
            for t in s.todos.iter_mut().filter(|t| t.group_id.is_none()) {
                t.group_id = Some(target.clone());
                if trash && t.deleted_at.is_none() {
                    t.deleted_at = Some(now);
                }
                t.revision += 1;
                t.updated_at = now;
            }
            s.default_group_id = Some(target);
        }
        "calendar.create" => {
            let c: Calendar = data(
                json!({"id":id(),"name":required(d,"name")?,"color":d["color"].as_str().unwrap_or("#2563eb"),"sortOrder":s.calendars.len(),"isDefault":false,"reminderMinutes":0,"sourceKind":"local","readOnly":false,"revision":1}),
            )?;
            result = Some(json!(c));
            s.calendars.push(c);
        }
        "calendar.update" => {
            // Read-only calendars (imports, subscriptions) may still be recolored locally.
            let color_only = d
                .as_object()
                .is_some_and(|m| m.keys().all(|k| k == "color"));
            if color_only {
                if !s.calendars.iter().any(|c| c.id == key) {
                    return Err("E:calendar_missing".into());
                }
            } else {
                writable(s, key)?;
            }
            if d["isDefault"] == true {
                for c in &mut s.calendars {
                    if c.is_default && c.id != key {
                        c.is_default = false;
                        c.revision += 1;
                    }
                }
            }
            let c = s
                .calendars
                .iter_mut()
                .find(|c| c.id == key)
                .ok_or("E:calendar_missing")?;
            *c = patch(
                c,
                d,
                &["name", "color", "sortOrder", "isDefault", "reminderMinutes"],
            )?;
            c.revision += 1;
            result = Some(json!(c));
        }
        "calendar.delete" => {
            writable(s, key)?;
            let replacement = required(d, "moveTo")?;
            if replacement == key {
                return Err("E:choose_other_calendar".into());
            }
            writable(s, replacement)?;
            let was_default = s.calendars.iter().any(|c| c.id == key && c.is_default);
            for e in &mut s.events {
                if e.calendar_id == key {
                    e.calendar_id = replacement.into();
                    e.revision += 1;
                    e.updated_at = now;
                }
            }
            s.calendars.retain(|c| c.id != key);
            if was_default {
                if let Some(c) = s.calendars.iter_mut().find(|c| c.id == replacement) {
                    c.is_default = true;
                    c.revision += 1;
                }
            }
        }
        "todo.create" => {
            let mut value = json!({"id":id(),"title":"","notes":"","status":"open","createdAt":now,"updatedAt":now,"revision":1});
            for field in [
                "title",
                "notes",
                "estimateMinutes",
                "dueAt",
                "dueDate",
                "dueTimeZone",
                "dueReminder",
                "groupId",
                "parentId",
                "tagIds",
                "priority",
                "reminderMinutes",
            ] {
                if let Some(v) = d.get(field) {
                    value[field] = v.clone();
                }
            }
            let mut t: Todo = data(value)?;
            if let Some(parent_id) = &t.parent_id {
                let parent = s
                    .todos
                    .iter()
                    .find(|p| &p.id == parent_id && p.deleted_at.is_none())
                    .ok_or("E:parent_missing_or_trashed")?;
                t.group_id = parent.group_id.clone();
            }
            if let Some(schedule) = d.get("schedule") {
                if schedule.as_object().is_none_or(|o| {
                    o.keys()
                        .any(|key| !["calendarId", "time"].contains(&key.as_str()))
                }) {
                    return Err("E:task_schedule_invalid".into());
                }
                let calendar = required(schedule, "calendarId")?;
                writable(s, calendar)?;
                let event: Event = data(
                    json!({"id":id(),"calendarId":calendar,"todoId":t.id,"title":t.title,"notes":t.notes,"tagIds":t.tag_ids,"time":schedule["time"],"revision":1,"createdAt":now,"updatedAt":now}),
                )?;
                s.events.push(event);
            }
            result = Some(json!(t));
            s.todos.push(t);
        }
        "todo.move" => {
            result = super::hierarchy::move_task(s, m, now)?;
        }
        "todo.update" => {
            let t = s
                .todos
                .iter_mut()
                .find(|t| t.id == key)
                .ok_or("E:task_missing")?;
            let was_completed = t.status == "completed";
            *t = patch(
                t,
                d,
                &[
                    "title",
                    "notes",
                    "status",
                    "estimateMinutes",
                    "dueAt",
                    "dueDate",
                    "dueTimeZone",
                    "dueReminder",
                    "groupId",
                    "parentId",
                    "tagIds",
                    "priority",
                    "reminderMinutes",
                ],
            )?;
            t.updated_at = now;
            t.revision += 1;
            t.completed_at = if t.status == "completed" {
                if was_completed {
                    t.completed_at.or(Some(now))
                } else {
                    Some(now)
                }
            } else {
                None
            };
            let parent_id = t.parent_id.clone();
            let group_id = t.group_id.clone();
            if let Some(parent_id) = parent_id {
                let parent = s
                    .todos
                    .iter()
                    .find(|p| p.id == parent_id && p.deleted_at.is_none())
                    .ok_or("E:parent_missing_or_trashed")?;
                let parent_group = parent.group_id.clone();
                let t = s.todos.iter_mut().find(|t| t.id == key).unwrap();
                if d.get("parentId").is_some() {
                    t.group_id = parent_group;
                } else if group_id != parent_group {
                    t.parent_id = None;
                }
            }
            super::hierarchy::sync_group(s, key, now);
            result = s.todos.iter().find(|t| t.id == key).map(|t| json!(t));
            sync_task_content(s, key, now);
        }
        "todo.purge" => {
            if !s
                .todos
                .iter()
                .any(|t| t.id == key && t.deleted_at.is_some())
            {
                return Err("E:purge_task_not_trashed".into());
            }
            let removed: std::collections::HashSet<String> = s
                .events
                .iter()
                .filter(|e| e.todo_id.as_deref() == Some(key))
                .map(|e| e.id.clone())
                .collect();
            s.events.retain(|e| {
                !removed.contains(&e.id)
                    && !e.series_id.as_ref().is_some_and(|id| removed.contains(id))
            });
            s.sources.retain(|l| {
                l.target_type != "event" || s.events.iter().any(|e| e.id == l.target_id)
            });
            s.todos.retain(|t| t.id != key);
            for child in s
                .todos
                .iter_mut()
                .filter(|t| t.parent_id.as_deref() == Some(key))
            {
                child.parent_id = None;
                child.revision += 1;
                child.updated_at = now;
            }
            s.sources
                .retain(|l| l.target_type != "todo" || l.target_id != key);
        }
        "todo.schedule" => {
            let calendar = required(d, "calendarId")?;
            writable(s, calendar)?;
            let t = s
                .todos
                .iter_mut()
                .find(|t| t.id == key)
                .ok_or("E:task_missing")?;
            if t.status == "completed" {
                return Err("E:restore_task_before_schedule".into());
            }
            if d.get("title").is_some() || d.get("notes").is_some() {
                let mut content = json!({});
                for field in ["title", "notes"] {
                    if let Some(value) = d.get(field) {
                        content[field] = value.clone();
                    }
                }
                *t = patch(t, &content, &["title", "notes"])?;
                t.revision += 1;
                t.updated_at = now;
            }
            let e: Event = data(
                json!({"id":id(),"calendarId":calendar,"todoId":key,"title":t.title,"notes":t.notes,"tagIds":t.tag_ids,"time":d["time"],"revision":1,"createdAt":now,"updatedAt":now}),
            )?;
            result = Some(json!(e));
            s.events.push(e);
            sync_task_content(s, key, now);
        }
        "event.create" => {
            if d["todoId"]
                .as_str()
                .is_some_and(|id| s.todos.iter().any(|t| t.id == id && t.deleted_at.is_some()))
            {
                return Err("E:restore_linked_task".into());
            }
            let calendar = required(d, "calendarId")?;
            writable(s, calendar)?;
            let mut value = json!({"id":id(),"calendarId":calendar,"title":required(d,"title")?,"time":d["time"],"revision":1,"createdAt":now,"updatedAt":now});
            for field in [
                "todoId",
                "notes",
                "titleOverride",
                "recurrence",
                "tagIds",
                "reminderMinutes",
            ] {
                if let Some(v) = d.get(field) {
                    value[field] = v.clone();
                }
            }
            let e: Event = data(value)?;
            result = Some(json!(e));
            s.events.push(e);
        }
        "event.update" => {
            let old = s
                .events
                .iter()
                .find(|e| e.id == key)
                .ok_or("E:event_missing")?;
            writable(s, &old.calendar_id)?;
            if let Some(target) = d["calendarId"].as_str() {
                writable(s, target)?;
            }
            let e = s.events.iter_mut().find(|e| e.id == key).unwrap();
            *e = patch(
                e,
                d,
                &[
                    "title",
                    "notes",
                    "time",
                    "titleOverride",
                    "calendarId",
                    "todoId",
                    "recurrence",
                    "tagIds",
                    "reminderMinutes",
                ],
            )?;
            e.revision += 1;
            e.updated_at = now;
            let task_id = e.todo_id.clone();
            if let Some(task_id) = task_id {
                let t = s
                    .todos
                    .iter_mut()
                    .find(|t| t.id == task_id)
                    .ok_or("E:linked_task_missing")?;
                let title = d
                    .get("title")
                    .or_else(|| d.get("titleOverride"))
                    .and_then(Value::as_str);
                let notes = d.get("notes").and_then(Value::as_str);
                if title.is_some_and(|v| v != t.title) || notes.is_some_and(|v| v != t.notes) {
                    if let Some(title) = title {
                        t.title = title.into();
                    }
                    if let Some(notes) = notes {
                        t.notes = notes.into();
                    }
                    t.revision += 1;
                    t.updated_at = now;
                }
                sync_task_content(s, &task_id, now);
            }
            result = s.events.iter().find(|e| e.id == key).map(|e| json!(e));
        }
        "event.exception" => {
            let old = s
                .events
                .iter()
                .find(|e| e.id == key)
                .ok_or("E:event_missing")?
                .clone();
            writable(s, &old.calendar_id)?;
            let day = required(d, "date")?;
            time::date(day)?;
            let first = time::midnight(
                day,
                match &old.time {
                    EventTime::Timed { time_zone, .. } | EventTime::AllDay { time_zone, .. } => {
                        time_zone
                    }
                },
            )?;
            let occurrence = time::occurrences(&old, first, first + 26 * 3_600_000)?
                .into_iter()
                .find(|e| e.original_date.as_deref() == Some(day))
                .ok_or("E:occurrence_missing")?;
            let master = s.events.iter_mut().find(|e| e.id == key).unwrap();
            let rule = master.recurrence.as_mut().ok_or("E:not_recurring")?;
            if rule.excluded_dates.contains(&day.into()) {
                return Err("E:occurrence_changed".into());
            }
            rule.excluded_dates.push(day.into());
            master.revision += 1;
            master.updated_at = now;
            {
                let mut e = old;
                e.id = id();
                e.series_id = Some(key.into());
                e.original_date = Some(day.into());
                e.recurrence = None;
                e.revision = 1;
                e.time = if d["delete"] == true {
                    occurrence.time
                } else {
                    data(d["time"].clone())?
                };
                e.deleted_at = if d["delete"] == true { Some(now) } else { None };
                e.updated_at = now;
                e.created_at = now;
                if let Some(name) = d["title"].as_str() {
                    e.title_override = Some(name.into());
                    e.title = name.into();
                }
                if let Some(notes) = d["notes"].as_str() {
                    e.notes = notes.into();
                }
                let event_id = e.id.clone();
                let task_id = e.todo_id.clone();
                s.events.push(e);
                if d["delete"] != true {
                    if let Some(task_id) = task_id {
                        let t = s
                            .todos
                            .iter_mut()
                            .find(|t| t.id == task_id)
                            .ok_or("E:linked_task_missing")?;
                        let title = d["title"].as_str();
                        let notes = d["notes"].as_str();
                        if title.is_some_and(|v| v != t.title)
                            || notes.is_some_and(|v| v != t.notes)
                        {
                            if let Some(title) = title {
                                t.title = title.into();
                            }
                            if let Some(notes) = notes {
                                t.notes = notes.into();
                            }
                            t.revision += 1;
                            t.updated_at = now;
                        }
                        sync_task_content(s, &task_id, now);
                    }
                }
                result = s.events.iter().find(|e| e.id == event_id).map(|e| json!(e));
            }
        }
        // "此日程及后续": the series ends the day before `date`; unless `delete`, a new series
        // starts there with the edits. Exceptions from `date` on belong to the old series and
        // are dropped, while deleted occurrences stay excluded in the new one.
        "event.split" => {
            let old = s
                .events
                .iter()
                .find(|e| e.id == key)
                .ok_or("E:event_missing")?
                .clone();
            writable(s, &old.calendar_id)?;
            if let Some(target) = d["calendarId"].as_str() {
                writable(s, target)?;
            }
            let rule = old.recurrence.clone().ok_or("E:not_recurring")?;
            let split = required(d, "date")?;
            let day = time::date(split)?;
            if day <= time::date(&time::local_date(&old.time)?)? {
                return Err("E:split_first".into());
            }
            let last = day.pred_opt().ok_or("E:date_invalid")?.to_string();
            // Count every occurrence before the split (excluded ones too) so a count-limited
            // series keeps its total across both halves.
            let mut probe = old.clone();
            if let Some(r) = probe.recurrence.as_mut() {
                r.excluded_dates.clear();
                r.until = Some(last.clone());
            }
            let before = time::occurrences(&probe, i64::MIN / 4, i64::MAX / 4)?.len() as u32;
            let remaining = rule.count.map(|c| c.saturating_sub(before));
            if remaining == Some(0) {
                return Err("E:occurrence_missing".into());
            }
            let carried: Vec<String> = rule
                .excluded_dates
                .iter()
                .filter(|x| x.as_str() >= split)
                .filter(|x| {
                    !s.events.iter().any(|e| {
                        e.series_id.as_deref() == Some(key)
                            && e.original_date.as_deref() == Some(x.as_str())
                            && e.deleted_at.is_none()
                    })
                })
                .cloned()
                .collect();
            s.events.retain(|e| {
                !(e.series_id.as_deref() == Some(key)
                    && e.original_date.as_deref().is_some_and(|x| x >= split))
            });
            let master = s.events.iter_mut().find(|e| e.id == key).unwrap();
            if let Some(r) = master.recurrence.as_mut() {
                r.until = Some(last);
                r.excluded_dates.retain(|x| x.as_str() < split);
            }
            master.revision += 1;
            master.updated_at = now;
            if d["delete"] == true {
                result = Some(json!(master));
            } else {
                let mut e = old.clone();
                e.id = id();
                e.revision = 1;
                e.created_at = now;
                e.updated_at = now;
                e.time = time::on_date(&old.time, day)?;
                e.recurrence = Some(Recurrence {
                    count: remaining,
                    excluded_dates: carried,
                    ..rule
                });
                let mut updates = d.clone();
                if let Some(map) = updates.as_object_mut() {
                    map.remove("date");
                    map.remove("delete");
                }
                let e: Event = patch(
                    &e,
                    &updates,
                    &[
                        "calendarId",
                        "title",
                        "notes",
                        "time",
                        "recurrence",
                        "reminderMinutes",
                    ],
                )?;
                result = Some(json!(e));
                s.events.push(e);
            }
        }
        "event.restoreException" => {
            let day = required(d, "date")?;
            time::date(day)?;
            let old = s
                .events
                .iter()
                .find(|e| e.id == key)
                .ok_or("E:series_missing")?;
            writable(s, &old.calendar_id)?;
            if let Some(exception_id) = d["exceptionId"].as_str() {
                let exception = s
                    .events
                    .iter()
                    .find(|e| {
                        e.id == exception_id
                            && e.series_id.as_deref() == Some(key)
                            && e.original_date.as_deref() == Some(day)
                    })
                    .ok_or("E:exception_missing")?;
                if Some(exception.revision) != d["exceptionRevision"].as_u64() {
                    return Err("E:exception_conflict".into());
                }
                s.events.retain(|e| e.id != exception_id);
            }
            let master = s.events.iter_mut().find(|e| e.id == key).unwrap();
            let rule = master.recurrence.as_mut().ok_or("E:recurrence_missing")?;
            if !rule.excluded_dates.iter().any(|d| d == day) {
                return Err("E:not_exception".into());
            }
            rule.excluded_dates.retain(|d| d != day);
            master.revision += 1;
            master.updated_at = now;
            result = Some(json!(master));
        }
        "event.purge" => {
            if !s
                .events
                .iter()
                .any(|e| e.id == key && e.deleted_at.is_some())
            {
                return Err("E:purge_event_not_trashed".into());
            }
            let e = s
                .events
                .iter()
                .find(|e| e.id == key)
                .ok_or("E:event_missing")?;
            writable(s, &e.calendar_id)?;
            s.events
                .retain(|e| e.id != key && e.series_id.as_deref() != Some(key));
            s.sources.retain(|l| {
                l.target_type != "event" || s.events.iter().any(|e| e.id == l.target_id)
            });
        }
        "reminder.create" => {
            let target = required(d, "targetId")?;
            let name = match required(d, "targetType")? {
                "todo" => s
                    .todos
                    .iter()
                    .find(|t| t.id == target)
                    .map(|t| t.title.clone()),
                "event" => s
                    .events
                    .iter()
                    .find(|e| e.id == target)
                    .map(|e| event_title(s, e)),
                _ => None,
            }
            .ok_or("E:reminder_target_missing")?;
            let r: Reminder = data(
                json!({"id":id(),"targetType":required(d,"targetType")?,"targetId":required(d,"targetId")?,"title":name,"origin":"manual","triggerAt":d["triggerAt"],"status":"pending","revision":1}),
            )?;
            result = Some(json!(r));
            s.reminders.push(r);
        }
        "reminder.acknowledge" | "reminder.snooze" => {
            let r = s
                .reminders
                .iter_mut()
                .find(|r| r.id == key)
                .ok_or("E:reminder_missing")?;
            if r.status != "pending" {
                return Err("E:reminder_handled".into());
            }
            if m.action.ends_with("snooze") {
                let minutes = d["minutes"]
                    .as_i64()
                    .filter(|v| *v > 0 && *v <= 10080)
                    .ok_or("E:snooze_range")?;
                r.snoozed_until = Some(now + minutes * 60_000);
                r.notified_at = None;
                r.lease_until = None;
                r.attempts = 0;
                r.next_attempt_at = 0;
            } else {
                r.status = "acknowledged".into();
            }
            r.revision += 1;
            result = Some(json!(r));
        }
        "reminder.delete" => s.reminders.retain(|r| r.id != key),
        "source.create" => {
            let source: SourceLink = data(
                json!({"id":id(),"targetType":required(d,"targetType")?,"targetId":required(d,"targetId")?,"providerKind":required(d,"providerKind")?,"accountId":d["accountId"],"externalId":required(d,"externalId")?,"title":required(d,"title")?,"revision":1}),
            )?;
            result = Some(json!(source));
            s.sources.push(source);
        }
        _ => return Err("E:unknown_action".into()),
    }
    Ok(result)
}

pub(crate) fn validate(s: &Snapshot) -> Result<(), String> {
    super::hierarchy::validate(s)?;
    if let Some(group) = &s.default_group_id {
        if !s.groups.iter().any(|g| &g.id == group) || s.todos.iter().any(|t| t.group_id.is_none())
        {
            return Err("E:default_list_invalid".into());
        }
    }
    time::zone(&s.time_zone)?;
    for rows in [
        json!(s.groups),
        json!(s.tags),
        json!(s.calendars),
        json!(s.todos),
        json!(s.events),
        json!(s.reminders),
        json!(s.sources),
    ] {
        let mut ids = std::collections::HashSet::new();
        for row in rows.as_array().unwrap() {
            let id = row["id"].as_str().ok_or("E:id_invalid")?;
            if id.is_empty() || id.len() > 200 || !ids.insert(id) {
                return Err("E:object_id_invalid".into());
            }
            if row["revision"]
                .as_u64()
                .is_none_or(|r| r == 0 || r > i64::MAX as u64)
            {
                return Err("E:revision_invalid".into());
            }
        }
    }
    for categories in [&s.groups, &s.tags] {
        let mut names = std::collections::HashSet::new();
        for c in categories {
            title(&c.name)?;
            if c.name.chars().count() > 60 || !names.insert(c.name.trim().to_lowercase()) {
                return Err("E:category_name_invalid".into());
            }
            if c.color.len() != 7
                || !c.color.starts_with('#')
                || !c.color[1..].bytes().all(|v| v.is_ascii_hexdigit())
            {
                return Err("E:category_color_invalid".into());
            }
        }
    }
    for r in &s.reminders {
        if !["pending", "acknowledged", "completed"].contains(&r.status.as_str())
            || !["todo_due", "event_start", "manual"].contains(&r.origin.as_str())
        {
            return Err("E:reminder_state_invalid".into());
        }
        if r.origin == "manual" && !target_exists(s, &r.target_type, &r.target_id) {
            return Err("E:reminder_target_missing".into());
        }
        timestamp(r.trigger_at)?;
    }
    for source in &s.sources {
        if !target_exists(s, &source.target_type, &source.target_id)
            || source.external_id.is_empty()
        {
            return Err("E:source_invalid".into());
        }
    }
    if s.calendars
        .iter()
        .filter(|c| c.is_default && !c.read_only)
        .count()
        != 1
    {
        return Err("E:default_calendar_required".into());
    }
    for c in &s.calendars {
        title(&c.name)?;
        if c.color.len() != 7
            || !c.color.starts_with('#')
            || !c.color[1..].bytes().all(|v| v.is_ascii_hexdigit())
        {
            return Err("E:calendar_color_invalid".into());
        }
        if c.reminder_minutes
            .is_some_and(|n| !(0..=10080).contains(&n))
        {
            return Err("E:reminder_offset_invalid".into());
        }
    }
    for t in &s.todos {
        if t.group_id
            .as_ref()
            .is_some_and(|id| !s.groups.iter().any(|g| &g.id == id))
        {
            return Err("E:task_list_missing".into());
        }
        validate_tags(s, &t.tag_ids)?;
        if !["low", "medium", "high"].contains(&t.priority.as_str())
            || !(0..=10080).contains(&t.reminder_minutes)
        {
            return Err("E:priority_or_offset_invalid".into());
        }
        title(&t.title)?;
        if t.notes.len() > 100_000 {
            return Err("E:notes_too_long".into());
        }
        if !["open", "completed"].contains(&t.status.as_str()) {
            return Err("E:task_status_invalid".into());
        }
        if t.estimate_minutes
            .is_some_and(|n| !(15..=10080).contains(&n))
        {
            return Err("E:estimate_range".into());
        }
        if t.due_at.is_some() && t.due_date.is_some() {
            return Err("E:due_conflict".into());
        }
        if let Some(at) = t.due_at {
            timestamp(at)?;
        }
        if let Some(day) = &t.due_date {
            time::date(day)?;
        }
        if let Some(tz) = &t.due_time_zone {
            time::zone(tz)?;
        }
    }
    for e in &s.events {
        if e.reminder_minutes
            .is_some_and(|n| n != EVENT_REMINDER_OFF && !(0..=10080).contains(&n))
        {
            return Err("E:reminder_offset_invalid".into());
        }
        validate_tags(s, &e.tag_ids)?;
        title(&e.title)?;
        time::bounds(&e.time)?;
        if e.notes.len() > 100_000 {
            return Err("E:notes_too_long".into());
        }
        if !s.calendars.iter().any(|c| c.id == e.calendar_id) {
            return Err("E:event_calendar_missing".into());
        }
        if e.todo_id
            .as_ref()
            .is_some_and(|tid| !s.todos.iter().any(|t| &t.id == tid))
        {
            return Err("E:event_task_missing".into());
        }
        if e.recurrence.is_some() {
            let (start, _) = time::bounds(&e.time)?;
            time::occurrences(e, start, start + 1)?;
        }
    }
    Ok(())
}

fn event_title(s: &Snapshot, e: &Event) -> String {
    e.todo_id
        .as_ref()
        .and_then(|id| s.todos.iter().find(|t| &t.id == id))
        .map(|t| t.title.clone())
        .unwrap_or_else(|| e.title_override.clone().unwrap_or_else(|| e.title.clone()))
}

// Task content has one owner; every schedule reflects the same title and notes.
fn sync_task_content(s: &mut Snapshot, task_id: &str, now: i64) {
    let Some(todo) = s.todos.iter().find(|t| t.id == task_id) else {
        return;
    };
    for event in s
        .events
        .iter_mut()
        .filter(|e| e.todo_id.as_deref() == Some(task_id))
    {
        if event.title != todo.title || event.notes != todo.notes || event.title_override.is_some()
        {
            event.title = todo.title.clone();
            event.notes = todo.notes.clone();
            event.title_override = None;
            event.revision += 1;
            event.updated_at = now;
        }
    }
}
pub(super) fn reconcile_reminders(
    s: &mut Snapshot,
    now: i64,
    catch_up: bool,
) -> Result<(), String> {
    let mut desired: Vec<(String, String, String, String, i64, bool)> = vec![];
    for t in &s.todos {
        if !t.due_reminder || t.deleted_at.is_some() {
            continue;
        }
        let at = if let Some(at) = t.due_at {
            Some(at)
        } else {
            t.due_date
                .as_deref()
                .map(|day| time::midnight(day, t.due_time_zone.as_deref().unwrap_or(&s.time_zone)))
                .transpose()?
        };
        if let Some(at) = at {
            desired.push((
                format!("todo:{}", t.id),
                "todo".into(),
                t.id.clone(),
                t.title.clone(),
                at - t.reminder_minutes * 60_000,
                t.status == "completed",
            ));
        }
    }
    for e in &s.events {
        if !super::trash::event_active(s, e) {
            continue;
        }
        let Some(minutes) = event_reminder(s, e) else {
            continue;
        };
        let complete = e.todo_id.as_ref().is_some_and(|tid| {
            s.todos
                .iter()
                .any(|t| &t.id == tid && t.status == "completed")
        });
        let events = if e.recurrence.is_some() {
            time::occurrences(e, now - 86_400_000, now + 32 * 86_400_000)?
        } else {
            vec![e.clone()]
        };
        for instance in events {
            let (start, _) = time::bounds(&instance.time)?;
            desired.push((
                format!("event:{}", instance.id),
                "event".into(),
                e.id.clone(),
                event_title(s, e),
                start - minutes * 60_000,
                complete,
            ));
        }
    }
    s.reminders.retain(|r| match r.target_type.as_str() {
        "todo" => s.todos.iter().any(|t| t.id == r.target_id),
        "event" => s.events.iter().any(|e| e.id == r.target_id),
        _ => false,
    });
    for (key, kind, target, title, trigger, completed) in &desired {
        if let Some(r) = s.reminders.iter_mut().find(|r| r.id == *key) {
            if r.title != *title {
                r.title = title.clone();
                r.revision += 1;
            }
            if *completed && r.status == "pending" {
                r.status = "completed".into();
                r.revision += 1;
            } else if !*completed && r.status == "completed" && *trigger > now {
                r.status = "pending".into();
                r.notified_at = None;
                r.attempts = 0;
                r.revision += 1;
            }
            if r.status == "pending" && r.snoozed_until.is_none() && r.trigger_at != *trigger {
                r.trigger_at = *trigger;
                r.notified_at = if *trigger < now { Some(now) } else { None };
                r.lease_until = None;
                r.attempts = 0;
                r.revision += 1;
            }
        } else if (*trigger >= now || (catch_up && *trigger >= now - 86_400_000)) && !*completed {
            s.reminders.push(Reminder {
                id: key.clone(),
                target_type: kind.clone(),
                target_id: target.clone(),
                title: title.clone(),
                origin: if kind == "todo" {
                    "todo_due".into()
                } else {
                    "event_start".into()
                },
                trigger_at: *trigger,
                snoozed_until: None,
                status: "pending".into(),
                notified_at: None,
                lease_until: None,
                attempts: 0,
                next_attempt_at: 0,
                revision: 1,
            });
        }
    }
    let inactive_events: std::collections::HashSet<String> = s
        .events
        .iter()
        .filter(|e| !super::trash::event_active(s, e))
        .map(|e| e.id.clone())
        .collect();
    let silent: std::collections::HashSet<String> = s
        .events
        .iter()
        .filter(|e| event_reminder(s, e).is_none())
        .map(|e| e.id.clone())
        .collect();
    for r in &mut s.reminders {
        if r.origin == "manual" {
            let name = if r.target_type == "todo" {
                s.todos
                    .iter()
                    .find(|t| t.id == r.target_id)
                    .map(|t| t.title.clone())
            } else {
                s.events.iter().find(|e| e.id == r.target_id).map(|e| {
                    e.todo_id
                        .as_ref()
                        .and_then(|id| s.todos.iter().find(|t| &t.id == id))
                        .map(|t| t.title.clone())
                        .unwrap_or_else(|| {
                            e.title_override.clone().unwrap_or_else(|| e.title.clone())
                        })
                })
            };
            if let Some(name) = name {
                if r.title != name {
                    r.title = name;
                    r.revision += 1;
                }
            }
        }
        let disabled = (r.origin == "todo_due"
            && s.todos
                .iter()
                .any(|t| t.id == r.target_id && !t.due_reminder))
            || (r.origin == "event_start" && silent.contains(&r.target_id));
        if disabled && r.status == "pending" {
            r.status = "completed".into();
            r.lease_until = None;
            r.revision += 1;
        }
        if r.origin != "manual"
            && r.status == "pending"
            && r.snoozed_until.is_none()
            && !desired.iter().any(|d| d.0 == r.id)
            && r.trigger_at > now
        {
            r.status = "completed".into();
            r.revision += 1;
        }
        let complete = if r.target_type == "todo" {
            s.todos
                .iter()
                .any(|t| t.id == r.target_id && (t.status == "completed" || t.deleted_at.is_some()))
        } else {
            s.events
                .iter()
                .find(|e| e.id == r.target_id)
                .is_some_and(|e| {
                    inactive_events.contains(&e.id)
                        || e.todo_id.as_ref().is_some_and(|id| {
                            s.todos
                                .iter()
                                .any(|t| &t.id == id && t.status == "completed")
                        })
                })
        };
        if !complete
            && r.origin == "manual"
            && r.status == "completed"
            && r.snoozed_until.unwrap_or(r.trigger_at) > now
        {
            r.status = "pending".into();
            r.notified_at = None;
            r.lease_until = None;
            r.attempts = 0;
            r.revision += 1;
        }
        if complete && r.status == "pending" {
            r.status = "completed".into();
            r.lease_until = None;
            r.revision += 1;
        }
    }
    Ok(())
}

fn timestamp(at: i64) -> Result<(), String> {
    if chrono::DateTime::from_timestamp_millis(at).is_none() {
        Err("E:timestamp_invalid".into())
    } else {
        Ok(())
    }
}
fn target_exists_parts(todos: &[Todo], events: &[Event], kind: &str, id: &str) -> bool {
    match kind {
        "todo" => todos.iter().any(|t| t.id == id),
        "event" => events.iter().any(|e| e.id == id),
        _ => false,
    }
}
fn target_exists(s: &Snapshot, kind: &str, id: &str) -> bool {
    target_exists_parts(&s.todos, &s.events, kind, id)
}
/// Minutes before an event's start to notify: its own setting, else the calendar default.
fn event_reminder(s: &Snapshot, e: &Event) -> Option<i64> {
    match e.reminder_minutes {
        Some(EVENT_REMINDER_OFF) => None,
        Some(minutes) => Some(minutes),
        None => {
            s.calendars
                .iter()
                .find(|c| c.id == e.calendar_id)?
                .reminder_minutes
        }
    }
}

fn validate_tags(s: &Snapshot, ids: &[String]) -> Result<(), String> {
    let unique: std::collections::HashSet<_> = ids.iter().collect();
    if ids.len() > 30
        || unique.len() != ids.len()
        || ids.iter().any(|id| !s.tags.iter().any(|t| &t.id == id))
    {
        return Err("E:tags_invalid".into());
    }
    Ok(())
}
