#[derive(Debug)]
struct ManagedUploadCleanupPlan {
    workdir: String,
    batches: Vec<String>,
}

fn collect_managed_upload_paths_from_value(
    value: &Value,
    path_pattern: &Regex,
    paths: &mut std::collections::BTreeSet<String>,
) {
    match value {
        Value::Array(items) => {
            for item in items {
                collect_managed_upload_paths_from_value(item, path_pattern, paths);
            }
        }
        Value::Object(object) => {
            for value in object.values() {
                collect_managed_upload_paths_from_value(value, path_pattern, paths);
            }
        }
        Value::String(text) => {
            for matched in path_pattern.find_iter(text) {
                let normalized = matched.as_str().replace('\\', "/");
                let relative_path = normalized.as_str();
                if crate::commands::upload_cleanup::is_managed_upload_relative_path(relative_path) {
                    paths.insert(relative_path.to_string());
                }
            }
        }
        _ => {}
    }
}

fn collect_managed_upload_paths_from_json(
    raw: &str,
    path_pattern: &Regex,
    paths: &mut std::collections::BTreeSet<String>,
) -> Result<(), String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    let parsed = serde_json::from_str::<Value>(trimmed)
        .map_err(|error| format!("解析历史附件引用失败：{error}"))?;
    collect_managed_upload_paths_from_value(&parsed, path_pattern, paths);
    Ok(())
}

fn prepare_managed_upload_cleanup(
    conn: &Connection,
    conversation_id: &str,
) -> Result<Option<ManagedUploadCleanupPlan>, String> {
    let target_workdir = conn
        .query_row(
            "SELECT cwd FROM chatHistory WHERE id = ?1",
            params![conversation_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|error| format!("读取待删除对话工作目录失败：{error}"))?
        .flatten()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let Some(target_workdir) = target_workdir else {
        return Ok(None);
    };
    let canonical_target =
        match crate::commands::upload_cleanup::canonicalize_upload_workdir(&target_workdir) {
            Ok(path) => path,
            Err(_) => return Ok(None),
        };

    let path_pattern = Regex::new(r"uploads[\\/][0-9]+[\\/][A-Za-z0-9._-]+")
        .map_err(|error| format!("构建上传附件路径规则失败：{error}"))?;
    let mut deleted_paths = std::collections::BTreeSet::new();
    let mut stmt = conn
        .prepare(
            "
            SELECT messages_json, summary_json
            FROM chatHistorySegment
            WHERE conversation_id = ?1
            ",
        )
        .map_err(|error| format!("准备历史附件引用查询失败：{error}"))?;
    let rows = stmt
        .query_map(params![conversation_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })
        .map_err(|error| format!("查询历史附件引用失败：{error}"))?;

    for row in rows {
        let (messages_json, summary_json) =
            row.map_err(|error| format!("读取历史附件引用失败：{error}"))?;
        collect_managed_upload_paths_from_json(&messages_json, &path_pattern, &mut deleted_paths)?;
        if let Some(summary_json) = summary_json {
            collect_managed_upload_paths_from_json(
                &summary_json,
                &path_pattern,
                &mut deleted_paths,
            )?;
        }
    }

    let deleted_batches = deleted_paths
        .iter()
        .filter_map(|path| {
            crate::commands::upload_cleanup::managed_upload_batch_for_relative_path(path)
        })
        .map(str::to_string)
        .collect::<std::collections::BTreeSet<_>>();
    if deleted_batches.is_empty() {
        return Ok(None);
    }

    // Compare batches globally instead of resolving every history workdir. This avoids
    // blocking on stale network paths and stays conservative when equivalent workdirs
    // were stored with different spellings (for example, a trailing separator).
    let mut retained_paths = std::collections::BTreeSet::new();
    let mut stmt = conn
        .prepare(
            "
            SELECT messages_json, summary_json
            FROM chatHistorySegment
            WHERE conversation_id <> ?1
              AND (
                instr(messages_json, 'uploads') > 0
                OR instr(COALESCE(summary_json, ''), 'uploads') > 0
              )
            ",
        )
        .map_err(|error| format!("准备保留附件引用查询失败：{error}"))?;
    let rows = stmt
        .query_map(params![conversation_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })
        .map_err(|error| format!("查询保留附件引用失败：{error}"))?;
    for row in rows {
        let (messages_json, summary_json) =
            row.map_err(|error| format!("读取保留附件引用失败：{error}"))?;
        collect_managed_upload_paths_from_json(&messages_json, &path_pattern, &mut retained_paths)?;
        if let Some(summary_json) = summary_json {
            collect_managed_upload_paths_from_json(
                &summary_json,
                &path_pattern,
                &mut retained_paths,
            )?;
        }
    }

    let retained_batches = retained_paths
        .iter()
        .filter_map(|path| {
            crate::commands::upload_cleanup::managed_upload_batch_for_relative_path(path)
        })
        .map(str::to_string)
        .collect::<std::collections::BTreeSet<_>>();
    let batches = deleted_batches
        .difference(&retained_batches)
        .cloned()
        .collect::<Vec<_>>();
    if batches.is_empty() {
        return Ok(None);
    }

    Ok(Some(ManagedUploadCleanupPlan {
        workdir: canonical_target.to_string_lossy().into_owned(),
        batches,
    }))
}

fn delete_chat_history_sync(
    conn: &mut Connection,
    id: &str,
) -> Result<subagent_store::SubagentPruneResult, String> {
    let chat_id = id.trim().to_string();
    if chat_id.is_empty() {
        return Err("历史对话 id 不能为空".to_string());
    }

    let existing = conn
        .query_row(
            "SELECT id FROM chatHistory WHERE id = ?1",
            params![chat_id.as_str()],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| format!("检查历史对话是否存在失败：{e}"))?;

    if existing.is_none() {
        return Err("未找到对应的历史对话".to_string());
    }

    let tx = conn
        .transaction()
        .map_err(|e| format!("开启删除历史事务失败：{e}"))?;
    let upload_cleanup = match prepare_managed_upload_cleanup(&tx, chat_id.as_str()) {
        Ok(plan) => plan,
        Err(error) => {
            eprintln!("Failed to prepare deleted conversation upload cleanup: {error}");
            None
        }
    };
    let subagent_prune_result =
        subagent_store::delete_subagent_history_for_parent_conversation(&tx, chat_id.as_str())?;
    delete_chat_history_conversation_fts(&tx, chat_id.as_str())?;
    tx.execute(
        "DELETE FROM chatHistorySegment WHERE conversation_id = ?1",
        params![chat_id.as_str()],
    )
    .map_err(|e| format!("删除历史分段失败：{e}"))?;
    tx.execute(
        "DELETE FROM chatHistory WHERE id = ?1",
        params![chat_id.as_str()],
    )
    .map_err(|e| format!("删除历史对话失败：{e}"))?;
    tx.commit()
        .map_err(|e| format!("提交删除历史事务失败：{e}"))?;

    if let Some(plan) = upload_cleanup {
        match crate::commands::upload_cleanup::cleanup_managed_upload_batches_sync(
            &plan.workdir,
            &plan.batches,
        ) {
            Ok(result) if !result.skipped.is_empty() => {
                eprintln!(
                    "Skipped some deleted conversation uploads: {}",
                    result.skipped.join(", ")
                );
            }
            Ok(_) => {}
            Err(error) => {
                eprintln!("Failed to cleanup deleted conversation uploads: {error}");
            }
        }
    }
    Ok(subagent_prune_result)
}

pub(crate) async fn chat_history_delete_inner(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let chat_id = id.trim().to_string();
        let mut conn = open_db()?;
        let mut subagent_prune_result = delete_chat_history_sync(&mut conn, &chat_id)?;
        subagent_store::cleanup_pruned_worktrees(&mut subagent_prune_result);
        if !subagent_prune_result.worktree_cleanup_errors.is_empty() {
            eprintln!(
                "Failed to cleanup some deleted conversation subagent worktrees: {}",
                subagent_prune_result.worktree_cleanup_errors.join("; ")
            );
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("chat_history_delete join 失败：{e}"))?
}

#[tauri::command]
pub async fn chat_history_delete(
    id: String,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<(), String> {
    let conversation_id = id.trim().to_string();
    chat_history_delete_inner(id).await?;
    gateway_controller
        .publish_history_sync(build_history_sync_delete(conversation_id))
        .await;
    Ok(())
}
