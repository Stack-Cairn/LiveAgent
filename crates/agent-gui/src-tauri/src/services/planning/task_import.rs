use super::{store::data, types::*};
use serde_json::{json, Value};

const PROVIDER: &str = "google-tasks";
/// Google's default list maps onto LiveAgent's list-less "My Tasks".
const DEFAULT_LISTS: [&str; 2] = ["My Tasks", "我的任务"];
const LIST_COLORS: [&str; 6] = [
    "#7C3AED", "#0F766E", "#D97706", "#DB2777", "#2563EB", "#65A30D",
];

fn text(entry: &Value, key: &str, max: usize) -> String {
    entry[key]
        .as_str()
        .unwrap_or("")
        .trim()
        .chars()
        .take(max)
        .collect()
}

/// Import reviewed Google Tasks (Takeout export) atomically. The source task ID prevents
/// duplicates across repeated imports; parents may come from an earlier batch.
pub(super) fn apply(s: &mut Snapshot, m: &Mutation, now: i64) -> Result<Option<Value>, String> {
    let entries = m
        .data
        .get("entries")
        .and_then(Value::as_array)
        .ok_or("E:import_invalid")?;
    if entries.is_empty() || entries.len() > 200 || m.data.as_object().is_none_or(|d| d.len() != 1)
    {
        return Err("E:import_count".into());
    }
    let (mut imported, mut skipped) = (0, 0);
    for entry in entries {
        if entry.as_object().is_none_or(|o| {
            o.keys().any(|key| {
                ![
                    "uid",
                    "list",
                    "title",
                    "notes",
                    "status",
                    "dueDate",
                    "completedAt",
                    "parentUid",
                ]
                .contains(&key.as_str())
            })
        }) {
            return Err("E:import_unknown_field".into());
        }
        let uid = entry["uid"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 512)
            .ok_or("E:import_missing_uid")?;
        let source_target = |s: &Snapshot, uid: &str| {
            s.sources
                .iter()
                .find(|r| r.provider_kind == PROVIDER && r.external_id == uid)
                .map(|r| r.target_id.clone())
        };
        if source_target(s, uid).is_some() {
            skipped += 1;
            continue;
        }
        let title = text(entry, "title", 500);
        if title.is_empty() {
            skipped += 1;
            continue;
        }
        let list = text(entry, "list", 60);
        let group_id = if list.is_empty() || DEFAULT_LISTS.contains(&list.as_str()) {
            None
        } else if let Some(group) = s
            .groups
            .iter()
            .find(|g| g.name.trim().to_lowercase() == list.to_lowercase())
        {
            Some(group.id.clone())
        } else {
            let group: PlanningCategory = data(json!({
                "id": uuid::Uuid::new_v4().to_string(),
                "name": list,
                "color": LIST_COLORS[s.groups.len() % LIST_COLORS.len()],
                "sortOrder": s.groups.len(),
                "revision": 1,
            }))?;
            let id = group.id.clone();
            s.groups.push(group);
            Some(id)
        };
        // A subtask keeps its parent only when the parent landed in the same list.
        let parent_id = entry["parentUid"]
            .as_str()
            .and_then(|parent| source_target(s, parent))
            .filter(|parent| {
                s.todos
                    .iter()
                    .any(|t| &t.id == parent && t.group_id == group_id && t.deleted_at.is_none())
            });
        let completed = entry["status"] == "completed";
        let due_date = entry["dueDate"]
            .as_str()
            .filter(|d| super::time::date(d).is_ok());
        let todo: Todo = data(json!({
            "id": uuid::Uuid::new_v4().to_string(),
            "title": title,
            "notes": text(entry, "notes", 20_000),
            "status": if completed { "completed" } else { "open" },
            "completedAt": if completed { entry["completedAt"].as_i64().or(Some(now)) } else { None },
            "dueDate": due_date,
            "dueTimeZone": due_date.map(|_| s.time_zone.clone()),
            "groupId": group_id,
            "parentId": parent_id,
            "sortOrder": s.todos.len(),
            "createdAt": now,
            "updatedAt": now,
            "revision": 1,
        }))?;
        let source: SourceLink = data(json!({
            "id": uuid::Uuid::new_v4().to_string(),
            "targetType": "todo",
            "targetId": todo.id,
            "providerKind": PROVIDER,
            "externalId": uid,
            "title": todo.title,
            "revision": 1,
        }))?;
        s.todos.push(todo);
        s.sources.push(source);
        imported += 1;
    }
    Ok(Some(json!({"imported":imported,"skipped":skipped})))
}
