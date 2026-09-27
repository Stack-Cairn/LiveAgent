use super::{store::writable, types::*};
use serde_json::{json, Value};

pub(super) fn event_active(s: &Snapshot, e: &Event) -> bool {
    e.deleted_at.is_none()
        && !e.series_id.as_ref().is_some_and(|id| {
            s.events
                .iter()
                .any(|v| &v.id == id && v.deleted_at.is_some())
        })
        && !e.todo_id.as_ref().is_some_and(|id| {
            s.todos
                .iter()
                .any(|t| &t.id == id && t.deleted_at.is_some())
        })
}

pub(super) fn apply(s: &mut Snapshot, m: &Mutation, now: i64) -> Result<Option<Value>, String> {
    if m.data.as_object().is_none_or(|d| !d.is_empty()) {
        return Err("E:trash_extra_fields".into());
    }
    let key = m.id.as_deref().ok_or("E:field_required:id")?;
    let restore = m.action.ends_with(".restore");
    if m.action.starts_with("todo.") {
        let t = s
            .todos
            .iter_mut()
            .find(|t| t.id == key)
            .ok_or("E:task_missing")?;
        if restore != t.deleted_at.is_some() {
            return Err("E:task_changed".into());
        }
        t.deleted_at = if restore { None } else { Some(now) };
        t.revision += 1;
        t.updated_at = now;
        let result = json!(t);
        if !restore {
            // Keep child tasks and their schedules available when a parent is recycled.
            for child in s
                .todos
                .iter_mut()
                .filter(|t| t.parent_id.as_deref() == Some(key))
            {
                child.parent_id = None;
                child.revision += 1;
                child.updated_at = now;
            }
        }
        Ok(Some(result))
    } else {
        let e = s
            .events
            .iter()
            .find(|e| e.id == key)
            .ok_or("E:event_missing")?;
        writable(s, &e.calendar_id)?;
        if restore != e.deleted_at.is_some() {
            return Err("E:event_changed".into());
        }
        if restore
            && e.series_id.as_ref().is_some_and(|id| {
                s.events
                    .iter()
                    .any(|v| &v.id == id && v.deleted_at.is_some())
            })
        {
            return Err("E:restore_series_first".into());
        }
        if restore
            && e.todo_id.as_ref().is_some_and(|id| {
                s.todos
                    .iter()
                    .any(|t| &t.id == id && t.deleted_at.is_some())
            })
        {
            return Err("E:restore_linked_task".into());
        }
        let e = s
            .events
            .iter_mut()
            .find(|e| e.id == key)
            .ok_or("E:event_missing")?;
        e.deleted_at = if restore { None } else { Some(now) };
        e.revision += 1;
        e.updated_at = now;
        Ok(Some(json!(e)))
    }
}
