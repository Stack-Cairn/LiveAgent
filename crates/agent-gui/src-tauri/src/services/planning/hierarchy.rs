use super::types::*;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

pub(super) fn descendants(s: &Snapshot, root: &str) -> HashSet<String> {
    let mut ids = HashSet::from([root.to_owned()]);
    loop {
        let old = ids.len();
        for t in &s.todos {
            if t.parent_id.as_ref().is_some_and(|id| ids.contains(id)) {
                ids.insert(t.id.clone());
            }
        }
        if old == ids.len() {
            break;
        }
    }
    ids
}

pub(super) fn validate(s: &Snapshot) -> Result<(), String> {
    let by_id: HashMap<_, _> = s.todos.iter().map(|t| (t.id.as_str(), t)).collect();
    let mut done = HashSet::new();
    for task in &s.todos {
        let mut path = HashSet::new();
        let mut current = Some(task.id.as_str());
        while let Some(id) = current {
            if done.contains(id) {
                break;
            }
            if !path.insert(id) {
                return Err("E:task_cycle".into());
            }
            let t = by_id.get(id).ok_or("E:parent_missing")?;
            current = t.parent_id.as_deref();
            if let Some(pid) = current {
                let parent = by_id.get(pid).ok_or("E:parent_missing")?;
                if parent.group_id != t.group_id {
                    return Err("E:parent_list_mismatch".into());
                }
            }
        }
        done.extend(path);
    }
    Ok(())
}

pub(super) fn sync_group(s: &mut Snapshot, key: &str, now: i64) {
    let group = s
        .todos
        .iter()
        .find(|t| t.id == key)
        .unwrap()
        .group_id
        .clone();
    let ids = descendants(s, key);
    for t in &mut s.todos {
        if ids.contains(&t.id) && t.group_id != group {
            t.group_id = group.clone();
            t.revision += 1;
            t.updated_at = now;
        }
    }
}

pub(super) fn move_task(s: &mut Snapshot, m: &Mutation, now: i64) -> Result<Option<Value>, String> {
    let key = m.id.as_deref().ok_or("E:field_required:id")?;
    let d = &m.data;
    let index = s
        .todos
        .iter()
        .position(|t| t.id == key && t.deleted_at.is_none())
        .ok_or("E:task_missing_or_trashed")?;
    let subtree = descendants(s, key);
    if d.get("parentId").is_some() && !d["parentId"].is_null() && !d["parentId"].is_string() {
        return Err("E:field_not_string_or_null:parentId".into());
    }
    if d.get("groupId").is_some() && !d["groupId"].is_null() && !d["groupId"].is_string() {
        return Err("E:field_not_string_or_null:groupId".into());
    }
    let parent = if d.get("parentId").is_some() {
        d["parentId"].as_str().map(str::to_owned)
    } else {
        s.todos[index].parent_id.clone()
    };
    let group = if let Some(pid) = &parent {
        if subtree.contains(pid) {
            return Err("E:task_cycle".into());
        }
        s.todos
            .iter()
            .find(|t| &t.id == pid && t.deleted_at.is_none())
            .ok_or("E:parent_missing_or_trashed")?
            .group_id
            .clone()
    } else if d.get("groupId").is_some() {
        d["groupId"].as_str().map(str::to_owned)
    } else {
        s.todos[index].group_id.clone()
    };
    if d.get("groupId").is_some() && parent.is_some() && d["groupId"].as_str() != group.as_deref() {
        return Err("E:target_list_mismatch".into());
    }
    for field in ["beforeId", "afterId"] {
        if d.get(field).is_some() && !d[field].is_string() {
            return Err(format!("E:field_not_string:{field}"));
        }
    }
    let before = d["beforeId"].as_str();
    let after = d["afterId"].as_str();
    if before.is_some() && after.is_some() {
        return Err("E:before_after_conflict".into());
    }
    let mut siblings: Vec<_> = s
        .todos
        .iter()
        .filter(|t| {
            t.id != key && t.deleted_at.is_none() && t.parent_id == parent && t.group_id == group
        })
        .map(|t| (t.id.clone(), t.sort_order, t.created_at))
        .collect();
    siblings.sort_by(|a, b| {
        a.1.cmp(&b.1)
            .then_with(|| b.2.cmp(&a.2))
            .then_with(|| a.0.cmp(&b.0))
    });
    let position = if let Some(anchor) = before.or(after) {
        let relative = s
            .todos
            .iter()
            .find(|t| t.id == anchor)
            .ok_or("E:order_target_missing")?;
        if d["relativeRevision"].as_u64() != Some(relative.revision) {
            return Err("E:order_target_changed".into());
        }
        let at = siblings
            .iter()
            .position(|t| t.0 == anchor)
            .ok_or("E:order_target_scope")?;
        at + usize::from(after.is_some())
    } else {
        siblings.len()
    };
    siblings.insert(position, (key.into(), 0, 0));
    s.todos[index].parent_id = parent;
    s.todos[index].group_id = group;
    for (i, (id, _, _)) in siblings.iter().enumerate() {
        let t = s.todos.iter_mut().find(|t| &t.id == id).unwrap();
        let order = (i as i64 + 1) * 1024;
        if t.sort_order != order || t.id == key {
            t.sort_order = order;
            t.revision += 1;
            t.updated_at = now;
        }
    }
    sync_group(s, key, now);
    validate(s)?;
    Ok(s.todos.iter().find(|t| t.id == key).map(|t| json!(t)))
}
