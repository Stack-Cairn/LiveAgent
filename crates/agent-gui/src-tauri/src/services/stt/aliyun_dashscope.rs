use super::{
    close_provider_socket, emit, provider_failure, send_provider_message, stage_failure, text,
    websocket_endpoint, SttCommand, SttEvent,
};
use futures_util::StreamExt;
use serde_json::Value;
use tauri::{AppHandle, Runtime};
use tokio::sync::mpsc::Receiver;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, http::header, Message},
};

fn dashscope_model(configured: String) -> String {
    if configured.is_empty() || configured == "paraformer-realtime-8k-v2" {
        "paraformer-realtime-v2".to_string()
    } else {
        configured
    }
}

fn finish_message(task_id: &str) -> Value {
    serde_json::json!({
        "header":{"action":"finish-task","task_id":task_id,"streaming":"duplex"},
        "payload":{"input":{}}
    })
}

pub async fn run<R: Runtime>(
    app: AppHandle<R>,
    session: String,
    config: serde_json::Map<String, Value>,
    mut rx: Receiver<SttCommand>,
) -> Result<(), String> {
    let key = text(&config, "apiKey");
    let endpoint = websocket_endpoint(&config, "wss://dashscope.aliyuncs.com/api-ws/v1/inference/")
        .map_err(|e| stage_failure("DashScope", "validate", e))?;
    let model = dashscope_model(text(&config, "model"));
    let task_id = uuid::Uuid::new_v4().simple().to_string();
    let mut request = endpoint
        .into_client_request()
        .map_err(|e| stage_failure("DashScope", "connect", e.to_string()))?;
    request.headers_mut().insert(
        header::AUTHORIZATION,
        format!("Bearer {key}")
            .parse()
            .map_err(|_| "无效 API Key")?,
    );
    request.headers_mut().insert(
        "X-DashScope-DataInspection",
        "enable"
            .parse()
            .map_err(|_| "DashScope 数据检查请求头无效")?,
    );
    let (socket, _) = connect_async(request)
        .await
        .map_err(|e| stage_failure("DashScope", "connect", format!("网络错误: {e}")))?;
    let (mut write, mut read) = socket.split();
    send_provider_message(&mut write, Message::Text( serde_json::json!({ "header":{"action":"run-task","task_id":task_id,"streaming":"duplex"}, "payload":{ "task_group":"audio","task":"asr","function":"recognition", "model":&model, "parameters":{ "format":"pcm", "sample_rate":16000, "language_hints":["zh", "en"], "max_sentence_silence":2000, "disfluency_removal_enabled":false }, "input":{} } }) .to_string() .into(), ), "DashScope", "start").await?;
    let mut ready = false;
    let mut finishing = false;
    let mut finish_sent = false;
    let mut pending = Vec::<Vec<u8>>::new();
    let mut finals = String::new();
    loop {
        tokio::select! {
            Some(command) = rx.recv() => match command {
                SttCommand::Audio { pcm, .. } => { if ready { send_provider_message(&mut write, Message::Binary(pcm.into()), "DashScope", "send_audio").await?; } else { pending.push(pcm); } }
                SttCommand::Finish => {
                    if !finishing { finishing = true; if ready { send_provider_message(&mut write, Message::Text(finish_message(&task_id).to_string().into()), "DashScope", "finish").await?; finish_sent = true; } }
                }
                SttCommand::Cancel => { close_provider_socket(&mut write).await; return Ok(()); }
            },
            Some(message) = read.next() => {
                let message = message.map_err(|e| stage_failure("DashScope", "receive", e.to_string()))?;
                let Message::Text(body) = message else { continue };
                let value: Value = serde_json::from_str(&body).map_err(|_| stage_failure("DashScope", "parse", "返回内容不是有效 JSON"))?;
                match value.pointer("/header/event").and_then(Value::as_str).unwrap_or_default() {
                    "task-started" => {
                        if !ready {
                            ready = true;
                            emit(&app, SttEvent::Ready { session_id: session.clone() });
                            for pcm in pending.drain(..) { send_provider_message(&mut write, Message::Binary(pcm.into()), "DashScope", "send_audio").await?; }
                            if finishing && !finish_sent {
                                send_provider_message(&mut write, Message::Text(finish_message(&task_id).to_string().into()), "DashScope", "finish").await?;
                                finish_sent = true;
                            }
                        }
                    }
                    "result-generated" => {
                        let sentence = value.pointer("/payload/output/sentence");
                        let sentence_text = sentence.and_then(|s| s.get("text")).and_then(Value::as_str).unwrap_or_default();
                        let ended = sentence.and_then(|s| s.get("end")).and_then(Value::as_bool).unwrap_or(false) || sentence.and_then(|s| s.get("sentence_end")).and_then(Value::as_bool).unwrap_or(false);
                        if ended { finals.push_str(sentence_text); }
                        let partial = if ended { finals.clone() } else { format!("{finals}{sentence_text}") };
                        emit(&app, SttEvent::Partial { session_id: session.clone(), text: partial });
                    }
                    "task-finished" if finish_sent => {
                        if !finals.is_empty() { emit(&app, SttEvent::Final { session_id: session.clone(), text: finals.clone() }); }
                        close_provider_socket(&mut write).await;
                        return Ok(());
                    }
                    "task-failed" => return Err(stage_failure("DashScope", "provider_response", provider_failure(
                        "DashScope",
                        value.pointer("/header/error_code").and_then(Value::as_str).unwrap_or_default(),
                        value.pointer("/header/error_message").and_then(Value::as_str).unwrap_or_default(),
                    ))),
                    _ => {}
                }
            }
            else => return Err(stage_failure("DashScope", "close", "连接在 task-finished 前关闭")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uses_16_khz_model_and_complete_finish_message() {
        assert_eq!(dashscope_model(String::new()), "paraformer-realtime-v2");
        assert_eq!(
            dashscope_model("paraformer-realtime-8k-v2".to_string()),
            "paraformer-realtime-v2"
        );
        let finish = finish_message("task");
        assert_eq!(
            finish.pointer("/header/streaming").and_then(Value::as_str),
            Some("duplex")
        );
        assert!(finish.pointer("/payload/input").is_some());
    }
}
