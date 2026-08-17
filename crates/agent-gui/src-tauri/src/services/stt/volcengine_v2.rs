use super::{
    emit, provider_failure, stage_failure, text, websocket_endpoint, SttCommand, SttEvent,
};
use flate2::{read::GzDecoder, write::GzEncoder, Compression};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::io::{Read, Write};
use tauri::{AppHandle, Runtime};
use tokio::sync::mpsc::Receiver;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{
        client::IntoClientRequest, http::header, protocol::frame::coding::CloseCode, Message,
    },
};

fn gzip_json(value: Value) -> Result<Vec<u8>, String> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder
        .write_all(value.to_string().as_bytes())
        .map_err(|e| e.to_string())?;
    encoder.finish().map_err(|e| e.to_string())
}

fn gzip_bytes(payload: &[u8]) -> Result<Vec<u8>, String> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(payload).map_err(|e| e.to_string())?;
    encoder.finish().map_err(|e| e.to_string())
}

fn frame(
    message_type: u8,
    flags: u8,
    serialization: u8,
    compression: u8,
    payload: &[u8],
) -> Vec<u8> {
    let mut output = vec![
        0x11,
        (message_type << 4) | flags,
        (serialization << 4) | compression,
        0,
    ];
    output.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    output.extend_from_slice(payload);
    output
}

fn decode_frame(data: &[u8]) -> Result<Value, String> {
    if data.len() < 8 {
        return Err("火山 v2 帧长度无效".into());
    }
    let header_len = ((data[0] & 0x0f) as usize) * 4;
    if header_len < 4 || data.len() < header_len + 4 {
        return Err("火山 v2 帧头无效".into());
    }
    let message_type = data[1] >> 4;
    let flags = data[1] & 0x0f;
    let mut offset = header_len;
    let mut error_code = 0_u32;
    let mut sequence = 0_i32;
    if message_type == 0x0f {
        if data.len() < offset + 8 {
            return Err("火山 v2 错误帧无效".into());
        }
        error_code = u32::from_be_bytes(data[offset..offset + 4].try_into().unwrap());
        offset += 4;
    } else if message_type == 0x0b || flags & 1 != 0 {
        if data.len() < offset + 8 {
            return Err("火山 v2 序列帧无效".into());
        }
        sequence = i32::from_be_bytes(data[offset..offset + 4].try_into().unwrap());
        offset += 4;
    }
    let payload_len = u32::from_be_bytes(data[offset..offset + 4].try_into().unwrap()) as usize;
    if data.len() < offset + 4 + payload_len {
        return Err("火山 v2 负载长度无效".into());
    }
    let mut payload = data[offset + 4..offset + 4 + payload_len].to_vec();
    if data[2] & 0x0f == 1 {
        let mut decoder = GzDecoder::new(payload.as_slice());
        let mut decoded = Vec::new();
        decoder
            .read_to_end(&mut decoded)
            .map_err(|_| "火山 v2 gzip 负载无效")?;
        payload = decoded;
    }
    if message_type == 0x0f {
        return Ok(
            serde_json::json!({"code": error_code, "message": String::from_utf8_lossy(&payload)}),
        );
    }
    let mut value: Value = serde_json::from_slice(&payload).map_err(|_| "火山 v2 响应协议错误")?;
    if let Some(object) = value.as_object_mut() {
        let payload_sequence = object
            .get("sequence")
            .and_then(Value::as_i64)
            .unwrap_or_default();
        object.insert("_sequence".into(), Value::from(sequence));
        object.insert(
            "_last".into(),
            Value::from(flags == 2 || flags == 3 || sequence < 0 || payload_sequence < 0),
        );
    }
    Ok(value)
}

fn response_is_no_speech(value: &Value) -> bool {
    value.get("code").and_then(Value::as_i64) == Some(1013)
}

fn start_request(
    config: &serde_json::Map<String, Value>,
    session: &str,
    request_id: &str,
) -> Value {
    serde_json::json!({
        "app": {"appid": text(config, "appId"), "token": text(config, "accessToken"), "cluster": text(config, "cluster")},
        "user": {"uid": session},
        "audio": {"format": "raw", "rate": 16000, "bits": 16, "channel": 1, "codec": "raw"},
        "request": {
            "reqid": request_id,
            "nbest": 1,
            "workflow": "audio_in,resample,partition,vad,fe,decode,itn,nlu_punctuate",
            "show_utterances": true,
            "result_type": "full",
            "sequence": 1
        }
    })
}

pub async fn run<R: Runtime>(
    app: AppHandle<R>,
    session: String,
    config: serde_json::Map<String, Value>,
    mut rx: Receiver<SttCommand>,
) -> Result<(), String> {
    let token = text(&config, "accessToken");
    let endpoint = websocket_endpoint(&config, "wss://openspeech.bytedance.com/api/v2/asr")
        .map_err(|e| stage_failure("VolcengineV2", "validate", e))?;
    let mut request = endpoint
        .into_client_request()
        .map_err(|e| stage_failure("VolcengineV2", "connect", e.to_string()))?;
    request.headers_mut().insert(
        header::AUTHORIZATION,
        format!("Bearer; {token}")
            .parse()
            .map_err(|_| stage_failure("VolcengineV2", "connect", "Access Token 无效"))?,
    );
    let (socket, _) = connect_async(request)
        .await
        .map_err(|e| stage_failure("VolcengineV2", "connect", format!("网络错误: {e}")))?;
    let (mut write, mut read) = socket.split();
    let request_id = uuid::Uuid::new_v4().to_string();
    let start = gzip_json(start_request(&config, &session, &request_id))?;
    write
        .send(Message::Binary(frame(1, 0, 1, 1, &start).into()))
        .await
        .map_err(|e| stage_failure("VolcengineV2", "start", e.to_string()))?;

    let mut ready = false;
    let mut pending = Vec::<Vec<u8>>::new();
    let mut finishing = false;
    let mut finish_sent = false;
    let mut last_text = String::new();
    loop {
        tokio::select! {
            Some(command) = rx.recv() => match command {
                SttCommand::Audio { pcm, .. } => {
                    if ready { let compressed = gzip_bytes(&pcm).map_err(|e| stage_failure("VolcengineV2", "send_audio", e))?; write.send(Message::Binary(frame(2, 0, 0, 1, &compressed).into())).await.map_err(|e| stage_failure("VolcengineV2", "send_audio", e.to_string()))?; }
                    else { pending.push(pcm); }
                }
                SttCommand::Finish => {
                    finishing = true;
                    if ready && !finish_sent {
                        let compressed = gzip_bytes(&[]).map_err(|e| stage_failure("VolcengineV2", "finish", e))?;
                        write.send(Message::Binary(frame(2, 2, 0, 1, &compressed).into())).await.map_err(|e| stage_failure("VolcengineV2", "finish", e.to_string()))?;
                        finish_sent = true;
                    }
                }
                SttCommand::Cancel => { let _ = write.close().await; return Ok(()); }
            },
            Some(message) = read.next() => {
                let message = message.map_err(|e| stage_failure("VolcengineV2", "receive", e.to_string()))?;
                let body = match message {
                    Message::Binary(body) => body,
                    Message::Close(frame) if finishing && finish_sent && frame.as_ref().is_none_or(|frame| frame.code == CloseCode::Normal) => {
                        if !last_text.is_empty() { emit(&app, SttEvent::Final { session_id: session.clone(), text: last_text.clone() }); }
                        return Ok(());
                    }
                    Message::Close(_) => return Err(stage_failure("VolcengineV2", "close", "在结束协议前异常关闭")),
                    _ => continue,
                };
                let value = decode_frame(&body).map_err(|e| stage_failure("VolcengineV2", "parse", e))?;
                let code = value.get("code").and_then(Value::as_i64).unwrap_or(0);
                let success = code == 0 || code == 1000 || value.get("message").and_then(Value::as_str) == Some("Success");
                if response_is_no_speech(&value) {
                    let _ = write.close().await;
                    return Ok(());
                }
                if !success { return Err(stage_failure("VolcengineV2", "provider_response", provider_failure("火山 v2", &code.to_string(), value.get("message").and_then(Value::as_str).unwrap_or_default()))); }
                if !ready {
                    ready = true;
                    emit(&app, SttEvent::Ready { session_id: session.clone() });
                    for pcm in pending.drain(..) { let compressed = gzip_bytes(&pcm).map_err(|e| stage_failure("VolcengineV2", "send_audio", e))?; write.send(Message::Binary(frame(2, 0, 0, 1, &compressed).into())).await.map_err(|e| stage_failure("VolcengineV2", "send_audio", e.to_string()))?; }
                    if finishing && !finish_sent {
                        let compressed = gzip_bytes(&[]).map_err(|e| stage_failure("VolcengineV2", "finish", e))?;
                        write.send(Message::Binary(frame(2, 2, 0, 1, &compressed).into())).await.map_err(|e| stage_failure("VolcengineV2", "finish", e.to_string()))?;
                        finish_sent = true;
                    }
                }
                let result_text = value.pointer("/result/text").and_then(Value::as_str)
                    .or_else(|| value.pointer("/result/0/text").and_then(Value::as_str))
                    .or_else(|| value.pointer("/payload/result/text").and_then(Value::as_str))
                    .or_else(|| value.pointer("/data/result/text").and_then(Value::as_str));
                if let Some(result_text) = result_text {
                    last_text = result_text.to_string();
                    emit(&app, SttEvent::Partial { session_id: session.clone(), text: last_text.clone() });
                }
                let completed = value.get("is_last_package").and_then(Value::as_bool).unwrap_or(false)
                    || value.get("_last").and_then(Value::as_bool).unwrap_or(false);
                if finishing && completed { if !last_text.is_empty() { emit(&app, SttEvent::Final { session_id: session.clone(), text: last_text.clone() }); } let _ = write.close().await; return Ok(()); }
            }
            else => {
                if finishing && finish_sent {
                    if !last_text.is_empty() { emit(&app, SttEvent::Final { session_id: session.clone(), text: last_text.clone() }); }
                    return Ok(());
                }
                break;
            },
        }
    }
    Err(stage_failure("VolcengineV2", "close", "在结束前关闭"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn full_request_contains_v2_auth_audio_and_workflow_fields() {
        let config = serde_json::from_value(json!({
            "appId": "app",
            "accessToken": "token",
            "cluster": "cluster"
        }))
        .expect("config map");
        let request = start_request(&config, "session", "request");
        assert_eq!(
            request.pointer("/app/token").and_then(Value::as_str),
            Some("token")
        );
        assert_eq!(
            request.pointer("/audio/format").and_then(Value::as_str),
            Some("raw")
        );
        assert_eq!(
            request.pointer("/audio/codec").and_then(Value::as_str),
            Some("raw")
        );
        assert_eq!(
            request
                .pointer("/request/show_utterances")
                .and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            request
                .pointer("/request/result_type")
                .and_then(Value::as_str),
            Some("full")
        );
    }

    #[test]
    fn classifies_1013_as_no_speech_only() {
        assert!(response_is_no_speech(&json!({
            "code": 1013,
            "message": "No valid speeches found in input audio"
        })));
        assert!(!response_is_no_speech(&json!({
            "code": 45000000,
            "message": "invalid request"
        })));
    }
}
