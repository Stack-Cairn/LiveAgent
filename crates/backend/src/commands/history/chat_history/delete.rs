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
    Ok(subagent_prune_result)
}

pub async fn chat_history_delete_inner(id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
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

pub async fn chat_history_delete(
    id: String,
    events: &Arc<EventBus>) -> Result<(), String> {
    let conversation_id = id.trim().to_string();
    chat_history_delete_inner(id).await?;
    events.emit(HISTORY_DELETE_EVENT, conversation_id);
    Ok(())
}
