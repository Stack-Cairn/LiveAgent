fn normalize_ssh_project_host_associations_value(
    value: Value,
    available_host_ids: Option<&HashSet<String>>,
) -> Result<Map<String, Value>, String> {
    let raw = match value {
        Value::Object(map) => map,
        Value::Null => Map::new(),
        _ => return Err("ssh.projectHostAssociations 必须是对象".to_string()),
    };
    let mut normalized = Map::new();
    let mut canonical_keys = HashSet::new();
    for (project_path_key, host_ids) in raw {
        let normalized_project_path_key = normalize_project_path_key(&project_path_key);
        if normalized_project_path_key.is_empty() {
            continue;
        }
        let items = expect_array(host_ids, "ssh.projectHostAssociations[]")?;
        let mut seen = HashSet::new();
        let mut ids = Vec::new();
        for item in items {
            let Some(host_id) = item.as_str().map(str::trim).filter(|id| !id.is_empty()) else {
                continue;
            };
            if available_host_ids.is_some_and(|available| !available.contains(host_id)) {
                continue;
            }
            if seen.insert(host_id.to_string()) {
                ids.push(Value::String(host_id.to_string()));
            }
            if ids.len() >= 64 {
                break;
            }
        }
        if !ids.is_empty() {
            insert_normalized_project_key_value(
                &mut normalized,
                &mut canonical_keys,
                &project_path_key,
                Value::Array(ids),
            );
        }
    }
    Ok(normalized)
}

fn insert_normalized_project_key_value(
    target: &mut Map<String, Value>,
    canonical_keys: &mut HashSet<String>,
    raw_project_path_key: &str,
    value: Value,
) {
    let normalized_project_path_key = normalize_project_path_key(raw_project_path_key);
    if normalized_project_path_key.is_empty() {
        return;
    }
    let is_canonical_key = raw_project_path_key.trim() == normalized_project_path_key;
    let existing_is_canonical = canonical_keys.contains(&normalized_project_path_key);
    if is_canonical_key || !existing_is_canonical {
        target.insert(normalized_project_path_key.clone(), value);
    }
    if is_canonical_key {
        canonical_keys.insert(normalized_project_path_key);
    }
}
