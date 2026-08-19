use super::{
    close_provider_socket, emit, provider_failure, send_provider_message, stage_failure, text,
    SttCommand, SttEvent,
};
use futures_util::StreamExt;
use hmac::{Hmac, Mac};
use serde_json::Value;
use sha1::Sha1;
use tauri::{AppHandle, Runtime};
use tokio::sync::mpsc::Receiver;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{protocol::frame::coding::CloseCode, Message},
};

type HmacSha1 = Hmac<Sha1>;

fn numeric_nonce() -> String {
    let bytes = uuid::Uuid::new_v4().into_bytes();
    u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
        .max(1)
        .to_string()
}

fn signed_url(config: &serde_json::Map<String, Value>, voice_id: &str) -> Result<String, String> {
    let app_id = text(config, "appId");
    let secret_id = text(config, "secretId");
    let secret_key = text(config, "secretKey");
    let path = format!("asr.cloud.tencent.com/asr/v2/{app_id}");
    let timestamp = chrono::Utc::now().timestamp();
    let mut parameters = std::collections::BTreeMap::from([
        ("convert_num_mode", "1".to_string()),
        ("engine_model_type", text(config, "engineModelType")),
        ("expired", (timestamp + 24 * 60 * 60).to_string()),
        ("filter_dirty", "1".to_string()),
        ("filter_modal", "2".to_string()),
        ("filter_punc", "0".to_string()),
        ("needvad", "0".to_string()),
        ("nonce", numeric_nonce()),
        ("secretid", secret_id),
        ("timestamp", timestamp.to_string()),
        ("voice_format", "1".to_string()),
        ("voice_id", voice_id.to_string()),
        ("word_info", "0".to_string()),
    ]);
    let query = parameters
        .iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join("&");
    let sign_text = format!("{path}?{query}");
    let mut mac = HmacSha1::new_from_slice(secret_key.as_bytes()).map_err(|_| "腾讯签名失败")?;
    mac.update(sign_text.as_bytes());
    let signature = base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        mac.finalize().into_bytes(),
    );
    parameters.insert("signature", signature);
    let encoded = parameters
        .iter()
        .map(|(key, value)| format!("{key}={}", urlencoding::encode(value)))
        .collect::<Vec<_>>()
        .join("&");
    Ok(format!("wss://{path}?{encoded}"))
}

pub async fn run<R: Runtime>(
    app: AppHandle<R>,
    session: String,
    config: serde_json::Map<String, Value>,
    mut rx: Receiver<SttCommand>,
) -> Result<(), String> {
    let voice_id = uuid::Uuid::new_v4().to_string();
    let endpoint =
        signed_url(&config, &voice_id).map_err(|e| stage_failure("Tencent", "validate", e))?;
    let (socket, _) = connect_async(endpoint)
        .await
        .map_err(|e| stage_failure("Tencent", "connect", format!("网络错误: {e}")))?;
    let (mut write, mut read) = socket.split();
    let mut fragments = std::collections::BTreeMap::<i64, String>::new();
    let mut finish_sent = false;
    emit(
        &app,
        SttEvent::Ready {
            session_id: session.clone(),
        },
    );
    tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    loop {
        tokio::select! {
            Some(command) = rx.recv() => match command {
                SttCommand::Audio { pcm, .. } => { if !finish_sent { send_provider_message(&mut write, Message::Binary(pcm.into()), "Tencent", "send_audio").await?; } }
                SttCommand::Finish => { if !finish_sent { finish_sent = true; send_provider_message(&mut write, Message::Text(serde_json::json!({"type":"end"}).to_string().into()), "Tencent", "finish").await?; } }
                SttCommand::Cancel => { close_provider_socket(&mut write).await; return Ok(()); }
            },
            Some(message) = read.next() => {
                let message = message.map_err(|e| stage_failure("Tencent", "receive", e.to_string()))?;
                match message {
                    Message::Text(body) => {
                        let value: Value = serde_json::from_str(&body).map_err(|_| stage_failure("Tencent", "parse", "返回内容不是有效 JSON"))?;
                        if let Some(code) = value.get("code").and_then(Value::as_i64).filter(|code| *code != 0) {
                            return Err(stage_failure("Tencent", "provider_response", provider_failure(
                                "腾讯云",
                                &code.to_string(),
                                value.get("message").and_then(Value::as_str).unwrap_or_default(),
                            )));
                        }
                        let index = value.pointer("/result/index").and_then(Value::as_i64).unwrap_or(0);
                        if let Some(text_value) = value.pointer("/result/voice_text_str").and_then(Value::as_str) {
                            fragments.insert(index, text_value.to_string());
                            let merged = fragments.values().cloned().collect::<String>();
                            emit(&app, SttEvent::Partial { session_id: session.clone(), text: merged });
                        }
                        let completed = value.get("type").and_then(Value::as_str) == Some("end")
                            || value.get("final").and_then(Value::as_i64) == Some(1);
                        if completed && finish_sent {
                            let final_text = fragments.values().cloned().collect::<String>();
                            if !final_text.is_empty() {
                                emit(&app, SttEvent::Final { session_id: session.clone(), text: final_text });
                            }
                            close_provider_socket(&mut write).await;
                            return Ok(());
                        }
                    }
                    Message::Close(frame) if finish_sent && frame.as_ref().is_none_or(|frame| frame.code == CloseCode::Normal) => {
                        let final_text = fragments.values().cloned().collect::<String>();
                        if !final_text.is_empty() { emit(&app, SttEvent::Final { session_id: session.clone(), text: final_text }); }
                        return Ok(());
                    }
                    Message::Close(_) => return Err(stage_failure("Tencent", "close", "连接在结束协议前异常关闭")),
                    _ => {}
                }
            }
            else => {
                if finish_sent {
                    let final_text = fragments.values().cloned().collect::<String>();
                    if !final_text.is_empty() { emit(&app, SttEvent::Final { session_id: session.clone(), text: final_text }); }
                    return Ok(());
                }
                return Err(stage_failure("Tencent", "close", "连接在结束协议前关闭"));
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn signed_url_contains_full_realtime_asr_parameter_set() {
        let config = serde_json::from_value(json!({
            "appId": "123",
            "secretId": "fixture-id",
            "secretKey": "fixture-key",
            "engineModelType": "16k_zh"
        }))
        .expect("config map");
        let endpoint = signed_url(&config, "voice-id").expect("signed URL");
        for field in [
            "convert_num_mode=1",
            "engine_model_type=16k_zh",
            "filter_dirty=1",
            "filter_modal=2",
            "filter_punc=0",
            "needvad=0",
            "voice_format=1",
            "voice_id=voice-id",
            "word_info=0",
            "signature=",
        ] {
            assert!(endpoint.contains(field), "missing Tencent field {field}");
        }
        let parsed = reqwest::Url::parse(&endpoint).expect("parse signed URL");
        let nonce = parsed
            .query_pairs()
            .find_map(|(key, value)| (key == "nonce").then(|| value.into_owned()))
            .expect("Tencent nonce");
        assert!(nonce.parse::<u32>().is_ok(), "nonce must be decimal");
        assert_ne!(nonce, "0");
    }
}
