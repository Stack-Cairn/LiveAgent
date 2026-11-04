use crate::services::planning::notification;

/// Shows a system notification for a chat run; clicking it opens the conversation.
#[tauri::command]
pub async fn chat_notification_deliver(
    app: tauri::AppHandle,
    conversation_id: String,
    title: String,
    body: String,
) -> Result<(), String> {
    notification::deliver(
        &app,
        notification::chat_notification_id(&conversation_id),
        title,
        body,
        true,
    )
    .await
}

/// Sets (or clears with `None`/0) the Dock / taskbar badge count.
#[tauri::command]
pub fn app_set_badge_count(app: tauri::AppHandle, count: Option<i64>) -> Result<(), String> {
    use tauri::Manager;
    let count = count.filter(|value| *value > 0);
    let Some(window) = app.get_webview_window(crate::MAIN_WINDOW_LABEL) else {
        return Ok(());
    };
    window.set_badge_count(count).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use crate::services::planning::notification::{
        chat_notification_id, conversation_id_from_notification_id,
    };

    #[test]
    fn chat_notification_id_round_trips_conversation_id() {
        let id = chat_notification_id("conv:with:colons");
        assert_eq!(
            conversation_id_from_notification_id(&id),
            Some("conv:with:colons")
        );
        assert_eq!(
            conversation_id_from_notification_id("planning-test-1"),
            None
        );
        assert_eq!(conversation_id_from_notification_id("chat-run::x"), None);
    }
}
