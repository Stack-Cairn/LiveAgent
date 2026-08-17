fn normalize_ssh_host_value(host: Value, label: &str) -> Result<Value, String> {
    let (host_id, mut payload) =
        validate_and_normalize_ssh_host(expect_object(host, label)?, label)?;
    payload.insert("id".to_string(), Value::String(host_id));
    Ok(Value::Object(payload))
}

fn normalize_ssh_hosts(hosts: Value, label: &str) -> Result<Vec<Value>, String> {
    expect_array(hosts, label)?
        .into_iter()
        .map(|host| normalize_ssh_host_value(host, "ssh patch host"))
        .collect()
}

fn ssh_host_id(host: &Value) -> Option<String> {
    host.get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(ToString::to_string)
}

fn find_ssh_host_index(hosts: &[Value], host_id: &str) -> Option<usize> {
    hosts.iter().position(|host| {
        host.get("id")
            .and_then(Value::as_str)
            .is_some_and(|id| id == host_id)
    })
}

fn public_ssh_host(host: &Value) -> Result<Value, String> {
    redact_ssh_host_secret(normalize_ssh_host_value(host.clone(), "ssh patch host")?)
}

fn collect_changed_leaf_paths(
    before: &Value,
    after: &Value,
    path: &mut Vec<String>,
    out: &mut Vec<Vec<String>>,
) {
    match (before, after) {
        (Value::Object(left), Value::Object(right)) => {
            let mut keys = left
                .keys()
                .chain(right.keys())
                .cloned()
                .collect::<HashSet<_>>()
                .into_iter()
                .collect::<Vec<_>>();
            keys.sort();
            for key in keys {
                path.push(key.clone());
                collect_changed_leaf_paths(
                    left.get(&key).unwrap_or(&Value::Null),
                    right.get(&key).unwrap_or(&Value::Null),
                    path,
                    out,
                );
                path.pop();
            }
        }
        _ if before != after => out.push(path.clone()),
        _ => {}
    }
}

fn value_at_path(value: &Value, path: &[String]) -> Value {
    let mut current = value;
    for key in path {
        let Some(next) = current.get(key) else {
            return Value::Null;
        };
        current = next;
    }
    current.clone()
}

fn set_value_at_path(target: &mut Value, path: &[String], value: Value) {
    if path.is_empty() {
        *target = value;
        return;
    }
    let mut current = target;
    for key in &path[..path.len() - 1] {
        if !current.is_object() {
            *current = Value::Object(Map::new());
        }
        let object = current.as_object_mut().expect("object just ensured");
        current = object
            .entry(key.clone())
            .or_insert_with(|| Value::Object(Map::new()));
    }
    if !current.is_object() {
        *current = Value::Object(Map::new());
    }
    if let Some(object) = current.as_object_mut() {
        object.insert(path[path.len() - 1].clone(), value);
    }
}

fn clear_ssh_host_secrets(host: &mut Value) {
    if let Some(object) = host.as_object_mut() {
        object.insert("password".to_string(), Value::String(String::new()));
        object.insert("privateKey".to_string(), Value::String(String::new()));
        object.insert(
            "privateKeyPassphrase".to_string(),
            Value::String(String::new()),
        );
    }
}

fn normalize_ssh_patch_host_id(change: &Map<String, Value>) -> Result<String, String> {
    extract_non_empty_string(change, "id", "sshPatch.hostChanges[]")
}

fn normalize_ssh_patch_host_endpoint(
    change: &Map<String, Value>,
    key: &str,
) -> Result<Option<Value>, String> {
    match change.get(key) {
        Some(Value::Null) | None => Ok(None),
        Some(value) => Ok(Some(normalize_ssh_host_value(
            value.clone(),
            &format!("sshPatch.hostChanges[].{key}"),
        )?)),
    }
}

fn normalize_ssh_host_id_array(
    value: Value,
    available_host_ids: &HashSet<String>,
) -> Result<Vec<Value>, String> {
    let mut seen = HashSet::new();
    let mut ids = Vec::new();
    for item in expect_array(value, "sshPatch.projectAssociationChanges[].before/after")? {
        let Some(host_id) = item.as_str().map(str::trim).filter(|id| !id.is_empty()) else {
            continue;
        };
        if !available_host_ids.contains(host_id) {
            continue;
        }
        if seen.insert(host_id.to_string()) {
            ids.push(Value::String(host_id.to_string()));
        }
        if ids.len() >= 64 {
            break;
        }
    }
    Ok(ids)
}

fn values_equal(left: Option<&Value>, right: Option<&Value>) -> bool {
    left.unwrap_or(&Value::Null) == right.unwrap_or(&Value::Null)
}

fn apply_ssh_host_change(
    hosts: &mut Vec<Value>,
    change: Value,
) -> Result<Option<SshPatchConflictCode>, String> {
    let change = expect_object(change, "sshPatch.hostChanges[]")?;
    let host_id = normalize_ssh_patch_host_id(&change)?;
    let before = normalize_ssh_patch_host_endpoint(&change, "before")?;
    let after = normalize_ssh_patch_host_endpoint(&change, "after")?;
    if before
        .as_ref()
        .and_then(ssh_host_id)
        .is_some_and(|id| id != host_id)
        || after
            .as_ref()
            .and_then(ssh_host_id)
            .is_some_and(|id| id != host_id)
    {
        return Err("sshPatch.hostChanges[] id 与主机内容不一致".to_string());
    }

    let current_index = find_ssh_host_index(hosts, &host_id);
    match (before, after, current_index) {
        (None, Some(after), None) => {
            hosts.push(after);
            Ok(None)
        }
        (None, Some(after), Some(index)) => {
            if public_ssh_host(&hosts[index])? == public_ssh_host(&after)? {
                Ok(None)
            } else {
                Ok(Some(SshPatchConflictCode::SettingsChanged))
            }
        }
        (Some(before), None, Some(index)) => {
            let current_public = public_ssh_host(&hosts[index])?;
            let before_public = public_ssh_host(&before)?;
            if current_public == before_public {
                hosts.remove(index);
                Ok(None)
            } else {
                Ok(Some(SshPatchConflictCode::SettingsChanged))
            }
        }
        (Some(_), None, None) => Ok(None),
        (Some(before), Some(after), Some(index)) => {
            let before_public = public_ssh_host(&before)?;
            let after_public = public_ssh_host(&after)?;
            let current_public = public_ssh_host(&hosts[index])?;
            let mut changed_paths = Vec::new();
            collect_changed_leaf_paths(
                &before_public,
                &after_public,
                &mut Vec::new(),
                &mut changed_paths,
            );
            let auth_type_changed = changed_paths
                .iter()
                .any(|path| path.len() == 1 && path[0] == "authType");
            let mut current_host = hosts[index].clone();
            if auth_type_changed {
                clear_ssh_host_secrets(&mut current_host);
            }
            for path in changed_paths {
                let current_value = value_at_path(&current_public, &path);
                let before_value = value_at_path(&before_public, &path);
                let after_value = value_at_path(&after_public, &path);
                if current_value != before_value && current_value != after_value {
                    return Ok(Some(SshPatchConflictCode::SettingsChanged));
                }
                set_value_at_path(&mut current_host, &path, after_value.clone());
            }
            hosts[index] = normalize_ssh_host_value(current_host, "sshPatch.hostChanges[].after")?;
            Ok(None)
        }
        (Some(_), Some(_), None) => Ok(Some(SshPatchConflictCode::SettingsChanged)),
        (None, None, _) => Err("sshPatch.hostChanges[] before/after 不能同时为空".to_string()),
    }
}

fn apply_ssh_secret_updates(
    hosts: &mut [Value],
    secret_updates: Value,
) -> Result<Option<SshPatchConflictCode>, String> {
    let updates = match secret_updates {
        Value::Object(map) => map,
        Value::Null => return Ok(None),
        _ => return Err("sshSecretUpdates 必须是对象".to_string()),
    };
    for (host_id, update) in updates {
        let Some(index) = find_ssh_host_index(hosts, host_id.trim()) else {
            return Ok(Some(SshPatchConflictCode::SettingsChanged));
        };
        let update = expect_object(update, "sshSecretUpdates[]")?;
        let auth_type = hosts[index]
            .get("authType")
            .and_then(Value::as_str)
            .unwrap_or("password")
            .to_string();
        let has_password_update = update.contains_key("password");
        let has_private_key_update = update.contains_key("privateKey");
        let has_private_key_passphrase_update = update.contains_key("privateKeyPassphrase");
        let has_proxy_password_update = update.contains_key("proxyPassword");
        let password = extract_optional_string(&update, "password");
        let private_key = extract_optional_string(&update, "privateKey");
        let private_key_passphrase = extract_optional_string(&update, "privateKeyPassphrase");
        let proxy_password = extract_optional_string(&update, "proxyPassword");
        if (has_password_update && auth_type != "password")
            || ((has_private_key_update || has_private_key_passphrase_update)
                && auth_type != "privateKey")
        {
            return Ok(Some(SshPatchConflictCode::SettingsChanged));
        }
        let Some(host) = hosts[index].as_object_mut() else {
            return Err("ssh host 必须是对象".to_string());
        };
        if has_password_update {
            host.insert("password".to_string(), Value::String(password));
            host.insert(
                "passwordConfigured".to_string(),
                Value::Bool(!extract_optional_string(host, "password").is_empty()),
            );
        }
        if has_private_key_update {
            host.insert("privateKey".to_string(), Value::String(private_key));
            host.insert(
                "privateKeyConfigured".to_string(),
                Value::Bool(!extract_optional_string(host, "privateKey").is_empty()),
            );
        }
        if has_private_key_passphrase_update {
            host.insert(
                "privateKeyPassphrase".to_string(),
                Value::String(private_key_passphrase),
            );
            host.insert(
                "privateKeyPassphraseConfigured".to_string(),
                Value::Bool(!extract_optional_string(host, "privateKeyPassphrase").is_empty()),
            );
        }
        if has_proxy_password_update {
            let proxy = host
                .entry("proxy".to_string())
                .or_insert_with(|| Value::Object(Map::new()));
            if !proxy.is_object() {
                *proxy = Value::Object(Map::new());
            }
            let proxy = proxy.as_object_mut().expect("object just ensured");
            proxy.insert("password".to_string(), Value::String(proxy_password));
            proxy.insert(
                "passwordConfigured".to_string(),
                Value::Bool(!extract_optional_string(proxy, "password").is_empty()),
            );
        }
        let normalized =
            normalize_ssh_host_value(Value::Object(host.clone()), "sshSecretUpdates[]")?;
        hosts[index] = normalized;
    }
    Ok(None)
}

fn apply_ssh_project_association_change(
    associations: &mut Map<String, Value>,
    available_host_ids: &HashSet<String>,
    change: Value,
) -> Result<Option<SshPatchConflictCode>, String> {
    let change = expect_object(change, "sshPatch.projectAssociationChanges[]")?;
    let raw_path_key =
        extract_non_empty_string(&change, "pathKey", "sshPatch.projectAssociationChanges[]")?;
    let path_key = normalize_project_path_key(&raw_path_key);
    if path_key.is_empty() {
        return Ok(None);
    }
    let before = normalize_ssh_host_id_array(
        change
            .get("before")
            .cloned()
            .unwrap_or(Value::Array(Vec::new())),
        available_host_ids,
    )?;
    let after = normalize_ssh_host_id_array(
        change
            .get("after")
            .cloned()
            .unwrap_or(Value::Array(Vec::new())),
        available_host_ids,
    )?;
    if before == after {
        return Ok(None);
    }
    let current = associations
        .get(&path_key)
        .cloned()
        .unwrap_or(Value::Array(Vec::new()));
    if values_equal(Some(&current), Some(&Value::Array(after.clone()))) {
        return Ok(None);
    }
    if !values_equal(Some(&current), Some(&Value::Array(before))) {
        return Ok(Some(SshPatchConflictCode::SettingsChanged));
    }
    if after.is_empty() {
        associations.remove(&path_key);
    } else {
        associations.insert(path_key, Value::Array(after));
    }
    Ok(None)
}

fn apply_ssh_host_order_change(
    hosts: &mut Vec<Value>,
    order_change: Value,
) -> Result<Option<SshPatchConflictCode>, String> {
    let order_change = expect_object(order_change, "sshPatch.hostOrderChange")?;
    let before = expect_array(
        order_change
            .get("before")
            .cloned()
            .unwrap_or(Value::Array(Vec::new())),
        "sshPatch.hostOrderChange.before",
    )?
    .into_iter()
    .filter_map(|value| value.as_str().map(str::trim).map(ToString::to_string))
    .filter(|id| !id.is_empty())
    .collect::<Vec<_>>();
    let after = expect_array(
        order_change
            .get("after")
            .cloned()
            .unwrap_or(Value::Array(Vec::new())),
        "sshPatch.hostOrderChange.after",
    )?
    .into_iter()
    .filter_map(|value| value.as_str().map(str::trim).map(ToString::to_string))
    .filter(|id| !id.is_empty())
    .collect::<Vec<_>>();
    let current_order = hosts.iter().filter_map(ssh_host_id).collect::<Vec<_>>();
    if current_order == after {
        return Ok(None);
    }
    if current_order != before {
        return Ok(Some(SshPatchConflictCode::SettingsChanged));
    }
    let mut by_id = hosts
        .drain(..)
        .filter_map(|host| ssh_host_id(&host).map(|id| (id, host)))
        .collect::<HashMap<_, _>>();
    let mut ordered = Vec::new();
    for id in after {
        if let Some(host) = by_id.remove(&id) {
            ordered.push(host);
        }
    }
    let mut rest = by_id.into_iter().collect::<Vec<_>>();
    rest.sort_by(|(left, _), (right, _)| left.cmp(right));
    ordered.extend(rest.into_iter().map(|(_, host)| host));
    *hosts = ordered;
    Ok(None)
}

fn apply_ssh_patch_to_value(
    current: Value,
    payload: Value,
) -> Result<Result<Value, SshPatchConflictCode>, String> {
    let mut payload = expect_object(payload, "settings_apply_ssh_patch payload")?;
    let ssh_patch = payload
        .remove(SSH_PATCH_FIELD)
        .unwrap_or(Value::Object(Map::new()));
    let secret_updates = payload
        .remove(SSH_SECRET_UPDATES_FIELD)
        .unwrap_or(Value::Object(Map::new()));
    let mut current = expect_object(current, "current ssh settings")?;
    let mut hosts = normalize_ssh_hosts(
        current.remove("hosts").unwrap_or(Value::Array(Vec::new())),
        "current ssh hosts",
    )?;
    let mut available_host_ids = hosts.iter().filter_map(ssh_host_id).collect::<HashSet<_>>();
    let mut associations = normalize_ssh_project_host_associations_value(
        current
            .remove("projectHostAssociations")
            .unwrap_or(Value::Object(Map::new())),
        Some(&available_host_ids),
    )?;
    let patch = expect_object(ssh_patch, "sshPatch")?;

    if let Some(host_changes) = patch.get("hostChanges") {
        for change in expect_array(host_changes.clone(), "sshPatch.hostChanges")? {
            if let Some(conflict) = apply_ssh_host_change(&mut hosts, change)? {
                return Ok(Err(conflict));
            }
        }
    }

    available_host_ids = hosts.iter().filter_map(ssh_host_id).collect::<HashSet<_>>();
    associations = normalize_ssh_project_host_associations_value(
        Value::Object(associations),
        Some(&available_host_ids),
    )?;

    if let Some(project_changes) = patch.get("projectAssociationChanges") {
        for change in expect_array(
            project_changes.clone(),
            "sshPatch.projectAssociationChanges",
        )? {
            if let Some(conflict) = apply_ssh_project_association_change(
                &mut associations,
                &available_host_ids,
                change,
            )? {
                return Ok(Err(conflict));
            }
        }
    }

    if let Some(order_change) = patch.get("hostOrderChange") {
        if let Some(conflict) = apply_ssh_host_order_change(&mut hosts, order_change.clone())? {
            return Ok(Err(conflict));
        }
    }

    if let Some(conflict) = apply_ssh_secret_updates(&mut hosts, secret_updates)? {
        return Ok(Err(conflict));
    }

    Ok(Ok(Value::Object(Map::from_iter([
        ("hosts".to_string(), Value::Array(hosts)),
        (
            "projectHostAssociations".to_string(),
            Value::Object(associations),
        ),
    ]))))
}

pub(crate) fn apply_ssh_patch_with_conn(
    conn: &mut Connection,
    payload: Value,
) -> Result<SshPatchApplyResponse, String> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| format!("开启 {SSH_SETTINGS_TABLE} patch 事务失败：{e}"))?;
    let current = load_ssh_or_empty(&tx)?;
    let merged = match apply_ssh_patch_to_value(current.clone(), payload)? {
        Ok(merged) => merged,
        Err(conflict) => {
            return Ok(SshPatchApplyResponse {
                ssh: current,
                conflict: Some(conflict),
            });
        }
    };
    save_ssh_rows(&tx, merged)?;
    let saved = load_ssh_or_empty(&tx)?;
    tx.commit()
        .map_err(|e| format!("提交 {SSH_SETTINGS_TABLE} patch 事务失败：{e}"))?;
    Ok(SshPatchApplyResponse {
        ssh: saved,
        conflict: None,
    })
}

