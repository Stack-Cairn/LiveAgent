fn load_system(conn: &Connection) -> Result<Option<Value>, String> {
    let mut stmt = conn
        .prepare(SYSTEM_SETTINGS_SELECT_SQL)
        .map_err(|e| format!("准备读取 {SYSTEM_SETTINGS_TABLE} 失败：{e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| format!("读取 {SYSTEM_SETTINGS_TABLE} 失败：{e}"))?;

    let mut system = Map::new();
    for row in rows {
        let (setting_key, payload_json) =
            row.map_err(|e| format!("读取 {SYSTEM_SETTINGS_TABLE} 行失败：{e}"))?;
        system.insert(
            setting_key,
            parse_json(&payload_json, SYSTEM_SETTINGS_TABLE)?,
        );
    }

    if system.is_empty() {
        Ok(None)
    } else {
        Ok(Some(Value::Object(system)))
    }
}

fn positive_number_value(value: Option<&Value>) -> Option<Value> {
    match value {
        Some(Value::Number(number)) if number.as_f64().is_some_and(|value| value > 0.0) => {
            Some(Value::Number(number.clone()))
        }
        _ => None,
    }
}

fn default_workspace_project_value(
    default_workdir: &str,
    existing_default_project: Option<&Map<String, Value>>,
) -> Value {
    let mut project = Map::new();
    project.insert(
        "id".to_string(),
        Value::String(DEFAULT_WORKSPACE_PROJECT_ID.to_string()),
    );
    project.insert(
        "name".to_string(),
        Value::String(DEFAULT_WORKSPACE_PROJECT_NAME.to_string()),
    );
    project.insert(
        "path".to_string(),
        Value::String(default_workdir.to_string()),
    );
    project.insert("kind".to_string(), Value::String("managed".to_string()));
    project.insert("createdAt".to_string(), json!(1));
    project.insert("updatedAt".to_string(), json!(1));

    if existing_default_project
        .and_then(|project| project.get("isPinned"))
        .and_then(Value::as_bool)
        == Some(true)
    {
        project.insert("isPinned".to_string(), Value::Bool(true));
        project.insert(
            "pinnedAt".to_string(),
            existing_default_project
                .and_then(|project| positive_number_value(project.get("pinnedAt")))
                .or_else(|| {
                    existing_default_project
                        .and_then(|project| positive_number_value(project.get("updatedAt")))
                })
                .unwrap_or_else(|| json!(1)),
        );
    }

    Value::Object(project)
}

fn normalize_workspace_projects_value(raw: Option<&Value>, default_workdir: &str) -> Value {
    let default_path = default_workdir.trim();
    let existing_default_project = match raw {
        Some(Value::Array(existing)) => existing.iter().find_map(|item| {
            let obj = item.as_object()?;
            let id = obj
                .get("id")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or_default();
            let path = obj
                .get("path")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or_default();
            if id == DEFAULT_WORKSPACE_PROJECT_ID || path == default_path {
                Some(obj)
            } else {
                None
            }
        }),
        _ => None,
    };
    let mut projects = vec![default_workspace_project_value(
        default_workdir,
        existing_default_project,
    )];
    if let Some(Value::Array(existing)) = raw {
        let mut seen_paths = HashSet::new();
        seen_paths.insert(default_path.to_string());
        for item in existing {
            let Some(obj) = item.as_object() else {
                continue;
            };
            let id = obj
                .get("id")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or_default();
            let path = obj
                .get("path")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or_default();
            if path.is_empty() || id == DEFAULT_WORKSPACE_PROJECT_ID || path == default_path {
                continue;
            }
            if !seen_paths.insert(path.to_string()) {
                continue;
            }
            projects.push(Value::Object(obj.clone()));
        }
    }
    Value::Array(projects)
}

fn normalize_hidden_workspace_project_paths(raw: Option<&Value>, default_workdir: &str) -> Value {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    if let Some(Value::Array(items)) = raw {
        for item in items {
            let Some(path) = item.as_str().map(str::trim).filter(|path| !path.is_empty()) else {
                continue;
            };
            if path == default_workdir || !seen.insert(path.to_string()) {
                continue;
            }
            out.push(Value::String(path.to_string()));
        }
    }
    Value::Array(out)
}

fn normalize_missing_workspace_project_paths(raw: Option<&Value>) -> Value {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    if let Some(Value::Array(items)) = raw {
        for item in items {
            let Some(path) = item.as_str().map(str::trim).filter(|path| !path.is_empty()) else {
                continue;
            };
            if !seen.insert(path.to_string()) {
                continue;
            }
            out.push(Value::String(path.to_string()));
        }
    }
    Value::Array(out)
}

fn normalize_archived_workspace_project_paths(raw: Option<&Value>) -> Value {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    if let Some(Value::Array(items)) = raw {
        for item in items {
            let Some(path) = item.as_str().map(str::trim).filter(|path| !path.is_empty()) else {
                continue;
            };
            if !seen.insert(path.to_string()) {
                continue;
            }
            out.push(Value::String(path.to_string()));
        }
    }
    Value::Array(out)
}

fn normalize_workspace_resource_ids(raw: Option<&Value>) -> Value {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    if let Some(Value::Array(items)) = raw {
        for item in items {
            let Some(id) = item.as_str().map(str::trim).filter(|id| !id.is_empty()) else {
                continue;
            };
            if seen.insert(id.to_string()) {
                out.push(Value::String(id.to_string()));
            }
            if out.len() >= 256 {
                break;
            }
        }
    }
    Value::Array(out)
}

const WORKSPACE_RESOURCE_TOMBSTONE_TTL_MS: u64 = 90 * 24 * 60 * 60 * 1000;
const MAX_WORKSPACE_RESOURCE_SETTINGS: usize = 256;

fn normalize_workspace_resource_settings(raw: Option<&Value>) -> Value {
    let Some(Value::Object(items)) = raw else {
        return Value::Object(Map::new());
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    let mut normalized_by_path = Map::new();
    for (raw_path_key, raw_entry) in items {
        let path_key = normalize_project_path_key(raw_path_key);
        if path_key.is_empty() {
            continue;
        }
        let Some(entry) = raw_entry.as_object() else {
            continue;
        };
        let mode = match entry.get("mode").and_then(Value::as_str) {
            Some("custom") => "custom",
            Some("off") => "off",
            _ => "inherit",
        };
        let state_version = entry
            .get("stateVersion")
            .and_then(Value::as_u64)
            .filter(|value| *value > 0)
            .unwrap_or(1);
        let writer_id = entry
            .get("writerId")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .chars()
            .take(64)
            .collect::<String>();
        let updated_at = entry
            .get("updatedAt")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        if mode == "inherit"
            && updated_at > 0
            && now.saturating_sub(updated_at) > WORKSPACE_RESOURCE_TOMBSTONE_TTL_MS
        {
            continue;
        }
        normalized_by_path.insert(
            path_key,
            json!({
                "mode": mode,
                "skillNames": if mode == "custom" {
                    normalize_workspace_resource_ids(entry.get("skillNames"))
                } else {
                    Value::Array(Vec::new())
                },
                "mcpServerIds": if mode == "custom" {
                    normalize_workspace_resource_ids(entry.get("mcpServerIds"))
                } else {
                    Value::Array(Vec::new())
                },
                "stateVersion": state_version,
                "writerId": writer_id,
                "updatedAt": updated_at,
            }),
        );
    }
    let mut normalized_entries = normalized_by_path.into_iter().collect::<Vec<_>>();
    normalized_entries.sort_by(|(path_a, entry_a), (path_b, entry_b)| {
        let active_a = entry_a["mode"] != "inherit";
        let active_b = entry_b["mode"] != "inherit";
        active_b
            .cmp(&active_a)
            .then_with(|| {
                entry_b["updatedAt"]
                    .as_u64()
                    .unwrap_or(0)
                    .cmp(&entry_a["updatedAt"].as_u64().unwrap_or(0))
            })
            .then_with(|| {
                entry_b["stateVersion"]
                    .as_u64()
                    .unwrap_or(0)
                    .cmp(&entry_a["stateVersion"].as_u64().unwrap_or(0))
            })
            .then_with(|| path_a.chars().cmp(path_b.chars()))
    });
    normalized_entries.truncate(MAX_WORKSPACE_RESOURCE_SETTINGS);
    let mut out = Map::new();
    for (path_key, entry) in normalized_entries {
        out.insert(path_key, entry);
    }
    Value::Object(out)
}

fn normalize_system_proxy_value(raw: Option<&Value>) -> Value {
    let obj = match raw {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    };
    let proxy_type = match obj.get("type").and_then(Value::as_str) {
        Some("socks5") => "socks5",
        _ => "http",
    };
    let host = obj
        .get("host")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    let port = obj
        .get("port")
        .and_then(Value::as_u64)
        .filter(|port| (1..=65535).contains(port))
        .unwrap_or(0);
    let username = obj
        .get("username")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    let password = obj.get("password").and_then(Value::as_str).unwrap_or_default();
    let password_configured = !password.trim().is_empty()
        || obj
            .get("passwordConfigured")
            .and_then(Value::as_bool)
            .unwrap_or(false);
    json!({
        "enabled": obj.get("enabled").and_then(Value::as_bool).unwrap_or(false),
        "type": proxy_type,
        "host": host,
        "port": port,
        "username": username,
        "password": password,
        "passwordConfigured": password_configured,
    })
}

fn system_value_with_defaults(raw: Option<Value>, default_workdir: &str) -> Value {
    let mut system = match raw {
        Some(Value::Object(system)) => system,
        _ => Map::new(),
    };

    let execution_mode = system
        .get(SYSTEM_EXECUTION_MODE_KEY)
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    if execution_mode.is_empty() {
        system.insert(
            SYSTEM_EXECUTION_MODE_KEY.to_string(),
            Value::String("tools".to_string()),
        );
    }

    let workdir = system
        .get(SYSTEM_WORKDIR_KEY)
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    if workdir.is_empty() {
        system.insert(
            SYSTEM_WORKDIR_KEY.to_string(),
            Value::String(default_workdir.to_string()),
        );
    }

    system.insert(
        SYSTEM_WORKSPACE_PROJECTS_KEY.to_string(),
        normalize_workspace_projects_value(
            system.get(SYSTEM_WORKSPACE_PROJECTS_KEY),
            default_workdir,
        ),
    );
    let requested_active_project_id = system
        .get(SYSTEM_ACTIVE_WORKSPACE_PROJECT_ID_KEY)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_WORKSPACE_PROJECT_ID)
        .to_string();
    let active_exists = system
        .get(SYSTEM_WORKSPACE_PROJECTS_KEY)
        .and_then(Value::as_array)
        .is_some_and(|projects| {
            projects.iter().any(|project| {
                project
                    .get("id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| id == requested_active_project_id)
            })
        });
    let active_project_id = if active_exists {
        requested_active_project_id
    } else {
        DEFAULT_WORKSPACE_PROJECT_ID.to_string()
    };
    let active_project_workdir = system
        .get(SYSTEM_WORKSPACE_PROJECTS_KEY)
        .and_then(Value::as_array)
        .and_then(|projects| {
            projects.iter().find_map(|project| {
                let id = project.get("id").and_then(Value::as_str)?;
                if id != active_project_id {
                    return None;
                }
                project
                    .get("path")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|path| !path.is_empty())
                    .map(ToString::to_string)
            })
        })
        .unwrap_or_else(|| default_workdir.to_string());
    system.insert(
        SYSTEM_ACTIVE_WORKSPACE_PROJECT_ID_KEY.to_string(),
        Value::String(active_project_id),
    );
    let execution_mode = system
        .get(SYSTEM_EXECUTION_MODE_KEY)
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("tools");
    if execution_mode != "text" {
        system.insert(
            SYSTEM_WORKDIR_KEY.to_string(),
            Value::String(active_project_workdir),
        );
    }
    system.insert(
        SYSTEM_HIDDEN_WORKSPACE_PROJECT_PATHS_KEY.to_string(),
        normalize_hidden_workspace_project_paths(
            system.get(SYSTEM_HIDDEN_WORKSPACE_PROJECT_PATHS_KEY),
            default_workdir,
        ),
    );
    system.insert(
        SYSTEM_MISSING_WORKSPACE_PROJECT_PATHS_KEY.to_string(),
        normalize_missing_workspace_project_paths(
            system.get(SYSTEM_MISSING_WORKSPACE_PROJECT_PATHS_KEY),
        ),
    );
    system.insert(
        SYSTEM_ARCHIVED_WORKSPACE_PROJECT_PATHS_KEY.to_string(),
        normalize_archived_workspace_project_paths(
            system.get(SYSTEM_ARCHIVED_WORKSPACE_PROJECT_PATHS_KEY),
        ),
    );
    system.insert(
        SYSTEM_WORKSPACE_RESOURCE_SETTINGS_KEY.to_string(),
        normalize_workspace_resource_settings(system.get(SYSTEM_WORKSPACE_RESOURCE_SETTINGS_KEY)),
    );
    system.insert(
        SYSTEM_SYSTEM_PROXY_KEY.to_string(),
        normalize_system_proxy_value(system.get(SYSTEM_SYSTEM_PROXY_KEY)),
    );

    Value::Object(system)
}

fn load_system_with_defaults(conn: &Connection, default_workdir: &str) -> Result<Value, String> {
    Ok(system_value_with_defaults(
        load_system(conn)?,
        default_workdir,
    ))
}
fn save_system(conn: &mut Connection, payload: Value) -> Result<(), String> {
    let default_workdir = default_project_workdir()?;
    save_system_with_default_workdir(conn, payload, &default_workdir)
}

fn save_system_with_default_workdir(
    conn: &mut Connection,
    payload: Value,
    default_workdir: &str,
) -> Result<(), String> {
    let system = match system_value_with_defaults(
        Some(Value::Object(expect_object(
            payload,
            "settings_save_system payload",
        )?)),
        default_workdir,
    ) {
        Value::Object(system) => system,
        _ => unreachable!(),
    };
    let updated_at = now_ms();
    let tx = conn
        .transaction()
        .map_err(|e| format!("开启 {SYSTEM_SETTINGS_TABLE} 事务失败：{e}"))?;
    tx.execute(SYSTEM_SETTINGS_DELETE_SQL, [])
        .map_err(|e| format!("清空 {SYSTEM_SETTINGS_TABLE} 失败：{e}"))?;

    for key in [
        SYSTEM_EXECUTION_MODE_KEY,
        SYSTEM_WORKDIR_KEY,
        SYSTEM_TOOL_POLICIES_KEY,
        SYSTEM_WORKSPACE_PROJECTS_KEY,
        SYSTEM_WORKSPACE_PROJECT_GROUPS_KEY,
        SYSTEM_ACTIVE_WORKSPACE_PROJECT_ID_KEY,
        SYSTEM_HIDDEN_WORKSPACE_PROJECT_PATHS_KEY,
        SYSTEM_MISSING_WORKSPACE_PROJECT_PATHS_KEY,
        SYSTEM_ARCHIVED_WORKSPACE_PROJECT_PATHS_KEY,
        SYSTEM_WORKSPACE_RESOURCE_SETTINGS_KEY,
        SYSTEM_SYSTEM_PROXY_KEY,
    ] {
        let value = system.get(key).cloned().unwrap_or(Value::Null);
        tx.execute(
            SYSTEM_SETTINGS_INSERT_SQL,
            params![
                key,
                serialize_json(&value, SYSTEM_SETTINGS_TABLE)?,
                updated_at
            ],
        )
        .map_err(|e| format!("写入 {SYSTEM_SETTINGS_TABLE}.{key} 失败：{e}"))?;
    }

    tx.commit()
        .map_err(|e| format!("提交 {SYSTEM_SETTINGS_TABLE} 事务失败：{e}"))?;
    crate::services::webdav_auto_sync::mark_dirty();
    Ok(())
}

/// 把 DB 中的 systemProxy 配置刷进全局代理状态（shell env 注入与 reqwest 出网共用）。
fn refresh_system_proxy_state(conn: &Connection) -> Result<(), String> {
    let system = load_system(conn)?;
    crate::services::system_proxy::set_config(
        system
            .as_ref()
            .and_then(|value| value.get(SYSTEM_SYSTEM_PROXY_KEY)),
    );
    Ok(())
}

/// 启动时初始化系统代理状态；失败不阻断启动（调用方仅记录日志）。
pub fn initialize_system_proxy_from_db() -> Result<(), String> {
    let conn = open_db()?;
    refresh_system_proxy_state(&conn)
}
