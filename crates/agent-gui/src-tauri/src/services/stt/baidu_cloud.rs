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
    tungstenite::{error::ProtocolError, Error as WebSocketError, Message},
};

fn baidu_finished_connection_closed(error: &WebSocketError) -> bool {
    matches!(
        error,
        WebSocketError::ConnectionClosed
            | WebSocketError::AlreadyClosed
            | WebSocketError::Protocol(ProtocolError::ResetWithoutClosingHandshake)
    )
}

fn result_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.trim().to_string(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join("")
            .trim()
            .to_string(),
        _ => String::new(),
    }
}

pub async fn run<R: Runtime>(
    app: AppHandle<R>,
    session: String,
    config: serde_json::Map<String, Value>,
    mut rx: Receiver<SttCommand>,
) -> Result<(), String> {
    let app_id = text(&config, "baiduAppId")
        .parse::<u64>()
        .map_err(|_| stage_failure("Baidu", "validate", "App ID 必须是数字"))?;
    let dev_pid = text(&config, "devPid")
        .parse::<u32>()
        .map_err(|_| stage_failure("Baidu", "validate", "dev_pid 必须是数字"))?;
    let app_key = text(&config, "baiduApiKey");
    let endpoint = websocket_endpoint(&config, "wss://vop.baidu.com/realtime_asr")
        .map_err(|e| stage_failure("Baidu", "validate", e))?;
    let endpoint = format!(
        "{endpoint}{}sn={}",
        if endpoint.contains('?') { "&" } else { "?" },
        uuid::Uuid::new_v4()
    );
    let (socket, _) = connect_async(endpoint)
        .await
        .map_err(|e| stage_failure("Baidu", "connect", format!("网络错误: {e}")))?;
    let (mut write, mut read) = socket.split();
    send_provider_message(&mut write, Message::Text( serde_json::json!({ "type":"START", "data": { "appid":app_id, "appkey":app_key, "dev_pid":dev_pid, "cuid":format!("LiveAgent-{}", uuid::Uuid::new_v4()), "format":"pcm", "sample":16000 } }) .to_string() .into(), ), "Baidu", "start").await?;
    // 百度协议没有 READY 消息，START 写入后即可发送已缓存音频。
    emit(
        &app,
        SttEvent::Ready {
            session_id: session.clone(),
        },
    );
    let mut finish_sent = false;
    let mut no_speech_seen = false;
    let mut final_text = String::new();
    loop {
        tokio::select! {
            Some(command) = rx.recv() => match command {
                SttCommand::Audio { pcm, .. } => { if !finish_sent { send_provider_message(&mut write, Message::Binary(pcm.into()), "Baidu", "send_audio").await?; } }
                SttCommand::Finish => { if !finish_sent { finish_sent = true; send_provider_message(&mut write, Message::Text(serde_json::json!({"type":"FINISH"}).to_string().into()), "Baidu", "finish").await?; if no_speech_seen { return Ok(()); } } }
                SttCommand::Cancel => { close_provider_socket(&mut write).await; return Ok(()); }
            },
            Some(message) = read.next() => {
                let message = match message {
                    Ok(message) => message,
                    Err(error) if finish_sent && baidu_finished_connection_closed(&error) => {
                        if !final_text.is_empty() {
                            emit(&app, SttEvent::Final { session_id: session.clone(), text: final_text.clone() });
                        }
                        return Ok(());
                    }
                    Err(error) => return Err(stage_failure("Baidu", "receive", error.to_string())),
                };
                match message {
                    Message::Text(body) => {
                        let value: Value = serde_json::from_str(&body).map_err(|_| stage_failure("Baidu", "parse", "返回内容不是有效 JSON"))?;
                        let err_no = value.get("err_no").and_then(Value::as_i64).unwrap_or(0);
                        let err_msg = value.get("err_msg").and_then(Value::as_str).unwrap_or("百度识别失败");
                        if err_no == 3301 || err_no == -3005 {
                            no_speech_seen = true;
                            if finish_sent { return Ok(()); }
                            continue;
                        }
                        if err_no != 0 { return Err(stage_failure("Baidu", "provider_response", provider_failure("百度", &err_no.to_string(), err_msg))); }
                        match value.get("type").and_then(Value::as_str) {
                            Some("MID_TEXT") => emit(&app, SttEvent::Partial { session_id: session.clone(), text: format!("{final_text}{}", result_text(value.get("result").unwrap_or(&Value::Null))) }),
                            Some("FIN_TEXT") => {
                                let text = result_text(value.get("result").unwrap_or(&Value::Null));
                                if !text.is_empty() { final_text.push_str(&text); }
                                emit(&app, SttEvent::Partial { session_id: session.clone(), text: final_text.clone() });
                                if finish_sent {
                                    if !final_text.is_empty() { emit(&app, SttEvent::Final { session_id: session.clone(), text: final_text.clone() }); }
                                    close_provider_socket(&mut write).await;
                                    return Ok(());
                                }
                            }
                            Some("FINISH") if finish_sent => { if !final_text.is_empty() { emit(&app, SttEvent::Final { session_id: session.clone(), text: final_text.clone() }); } close_provider_socket(&mut write).await; return Ok(()); }
                            _ => {}
                        }
                    }
                    Message::Close(_) => return if finish_sent { if !final_text.is_empty() { emit(&app, SttEvent::Final { session_id: session.clone(), text: final_text.clone() }); } Ok(()) } else { Err(stage_failure("Baidu", "close", "连接在 FINISH 前关闭")) },
                    _ => {}
                }
            }
            else => return if finish_sent { if !final_text.is_empty() { emit(&app, SttEvent::Final { session_id: session.clone(), text: final_text.clone() }); } Ok(()) } else { Err(stage_failure("Baidu", "close", "连接在 FINISH 前关闭")) },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn response_text_accepts_string_and_array_results() {
        assert_eq!(result_text(&json!(" 单句 ")), "单句");
        assert_eq!(result_text(&json!(["你好，", "世界。"])), "你好，世界。");
    }

    #[test]
    fn finish_accepts_only_normal_websocket_shutdown_errors() {
        assert!(baidu_finished_connection_closed(
            &WebSocketError::ConnectionClosed
        ));
        assert!(baidu_finished_connection_closed(
            &WebSocketError::AlreadyClosed
        ));
        assert!(baidu_finished_connection_closed(&WebSocketError::Protocol(
            ProtocolError::ResetWithoutClosingHandshake
        )));
        assert!(!baidu_finished_connection_closed(
            &WebSocketError::Protocol(ProtocolError::InvalidOpcode(3))
        ));
    }
}
