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
        client::IntoClientRequest, http::Request, protocol::frame::coding::CloseCode,
        Error as WebSocketError, Message,
    },
};

const SEED_V3_ENDPOINT: &str = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async";

fn seed_v3_connect_failure(error: WebSocketError) -> String {
    match error {
        WebSocketError::Http(response) => {
            let status = response.status();
            let category = if status.as_u16() == 401 || status.as_u16() == 403 {
                "authentication_failed"
            } else if status.is_server_error() {
                "network_failed"
            } else {
                "protocol_failed"
            };
            format!(
                "{category}: 火山 Seed v3 WebSocket 握手失败（HTTP {}）",
                status.as_u16()
            )
        }
        other => format!("network_failed: {other}"),
    }
}

fn seed_v3_websocket_request(
    config: &serde_json::Map<String, Value>,
    connect_id: &str,
) -> Result<Request<()>, String> {
    let endpoint = websocket_endpoint(config, SEED_V3_ENDPOINT)
        .map_err(|error| stage_failure("VolcengineSeedV3", "validate", error))?;
    let mut request = endpoint
        .into_client_request()
        .map_err(|_| stage_failure("VolcengineSeedV3", "validate", "WebSocket 地址无效"))?;
    for (name, value, label) in [
        ("X-Api-App-Key", text(config, "appId"), "App ID"),
        (
            "X-Api-Access-Key",
            text(config, "accessToken"),
            "Access Token",
        ),
        (
            "X-Api-Resource-Id",
            text(config, "resourceId"),
            "Resource ID",
        ),
        ("X-Api-Connect-Id", connect_id.to_string(), "连接 ID"),
    ] {
        request.headers_mut().insert(
            name,
            value.parse().map_err(|_| {
                stage_failure("VolcengineSeedV3", "connect", format!("{label} 无效"))
            })?,
        );
    }
    Ok(request)
}

fn seed_v3_json(value: Value) -> Result<Vec<u8>, String> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder
        .write_all(value.to_string().as_bytes())
        .map_err(|e| stage_failure("VolcengineSeedV3", "connect", e.to_string()))?;
    encoder.finish().map_err(|e| e.to_string())
}

fn seed_v3_start_request(session: &str) -> Value {
    serde_json::json!({
        "user": {"uid": session},
        "audio": {"format":"pcm", "codec":"raw", "rate":16000, "bits":16, "channel":1},
        "request": {
            "model_name":"bigmodel",
            "enable_itn":true,
            "enable_punc":true,
            "enable_ddc":true,
            "show_utterances":true,
            "result_type":"full"
        }
    })
}
fn seed_v3_audio(payload: &[u8]) -> Result<Vec<u8>, String> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(payload).map_err(|e| e.to_string())?;
    encoder.finish().map_err(|e| e.to_string())
}
fn seed_v3_frame(message_type: u8, flags: u8, serialization: u8, payload: &[u8]) -> Vec<u8> {
    let mut output = vec![
        0x11,
        (message_type << 4) | flags,
        (serialization << 4) | 0x01,
        0,
    ];
    output.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    output.extend_from_slice(payload);
    output
}
fn seed_v3_audio_frame(last: bool, payload: &[u8]) -> Vec<u8> {
    // bigmodel_async assigns request sequences server-side. Audio-only client
    // frames therefore omit the optional sequence field entirely.
    seed_v3_frame(2, if last { 2 } else { 0 }, 0, payload)
}
fn decode_seed_v3_frame(data: &[u8]) -> Result<Value, String> {
    if data.len() < 8 || data[0] & 0x0f < 1 {
        return Err("火山 Seed v3 帧无效".into());
    }
    let header_len = (data[0] & 0x0f) as usize * 4;
    if data.len() < header_len + 4 {
        return Err("火山 Seed v3 帧头无效".into());
    }
    let message_type = data[1] >> 4;
    let flags = data[1] & 0x0f;
    let mut offset = header_len;
    let mut error_code = 0_u32;
    let mut sequence = 0_i32;
    if message_type == 0x0f {
        if data.len() < offset + 8 {
            return Err("火山 Seed v3 错误帧无效".into());
        }
        error_code = u32::from_be_bytes(data[offset..offset + 4].try_into().unwrap());
        offset += 4;
    } else if flags & 1 != 0 {
        if data.len() < offset + 8 {
            return Err("火山 Seed v3 序列帧无效".into());
        }
        sequence = i32::from_be_bytes(data[offset..offset + 4].try_into().unwrap());
        offset += 4;
    }
    let payload_len = u32::from_be_bytes(
        data[offset..offset + 4]
            .try_into()
            .map_err(|_| "火山 Seed v3 负载长度无效")?,
    ) as usize;
    if data.len() < offset + 4 + payload_len {
        return Err("火山 Seed v3 负载长度无效".into());
    }
    let mut payload = data[offset + 4..offset + 4 + payload_len].to_vec();
    if data[2] & 0x0f == 1 {
        let mut decoder = GzDecoder::new(payload.as_slice());
        let mut decoded = Vec::new();
        decoder
            .read_to_end(&mut decoded)
            .map_err(|_| "火山 Seed v3 gzip 负载无效")?;
        payload = decoded;
    }
    if message_type == 0x0f {
        return Ok(
            serde_json::json!({"code": error_code, "message": String::from_utf8_lossy(&payload)}),
        );
    }
    let mut value: Value =
        serde_json::from_slice(&payload).map_err(|_| "火山 Seed v3 响应协议错误")?;
    if let Some(object) = value.as_object_mut() {
        object.insert("_sequence".into(), Value::from(sequence));
        object.insert(
            "_last".into(),
            Value::from(flags == 2 || flags == 3 || sequence < 0),
        );
    }
    Ok(value)
}

pub async fn run<R: Runtime>(
    app: AppHandle<R>,
    session: String,
    config: serde_json::Map<String, Value>,
    mut rx: Receiver<SttCommand>,
) -> Result<(), String> {
    let connect_id = uuid::Uuid::new_v4().to_string();
    let request = seed_v3_websocket_request(&config, &connect_id)?;
    let (socket, _) = connect_async(request)
        .await
        .map_err(|e| stage_failure("VolcengineSeedV3", "connect", seed_v3_connect_failure(e)))?;
    let (mut write, mut read) = socket.split();
    let start = seed_v3_json(seed_v3_start_request(&session))?;
    write
        .send(Message::Binary(seed_v3_frame(1, 0, 1, &start).into()))
        .await
        .map_err(|e| stage_failure("VolcengineSeedV3", "start", e.to_string()))?;
    // The WebSocket upgrade only validates the transport. Wait for the first
    // successful v3 binary response before releasing buffered microphone data.
    let mut ready = false;
    let mut finishing = false;
    let mut finish_sent = false;
    let mut pending = Vec::<(u32, Vec<u8>)>::new();
    let mut held_audio = None::<(u32, Vec<u8>)>;
    let mut last_text = String::new();
    loop {
        tokio::select! {
            Some(command) = rx.recv() => match command {
                SttCommand::Audio { sequence, pcm } => {
                    if ready {
                        if let Some((_previous_sequence, previous_pcm)) = held_audio.replace((sequence, pcm)) {
                            let compressed = seed_v3_audio(&previous_pcm)?;
                            let frame = seed_v3_audio_frame(false, &compressed);
                            write.send(Message::Binary(frame.into())).await.map_err(|e| stage_failure("VolcengineSeedV3", "send_audio", e.to_string()))?;
                        }
                    } else {
                        pending.push((sequence, pcm));
                    }
                }
                SttCommand::Finish => {
                    finishing = true;
                    if ready && !finish_sent {
                        let (_sequence, pcm) = held_audio.take().unwrap_or_default();
                        let compressed = seed_v3_audio(&pcm)?;
                        let frame = seed_v3_audio_frame(true, &compressed);
                        write.send(Message::Binary(frame.into())).await.map_err(|e| stage_failure("VolcengineSeedV3", "finish", e.to_string()))?;
                        finish_sent = true;
                    }
                }
                SttCommand::Cancel => { let _ = write.close().await; return Ok(()); }
            },
            Some(message) = read.next() => { let message = message.map_err(|e| stage_failure("VolcengineSeedV3", "receive", e.to_string()))?; let body = match message { Message::Binary(body) => body, Message::Close(frame) if finishing && finish_sent && frame.as_ref().is_none_or(|frame| frame.code == CloseCode::Normal) => { if !last_text.is_empty() { emit(&app, SttEvent::Final { session_id: session.clone(), text: last_text.clone() }); } return Ok(()); }, Message::Close(_) => return Err(stage_failure("VolcengineSeedV3", "close", "连接异常关闭")), _ => continue }; let value = decode_seed_v3_frame(&body).map_err(|e| stage_failure("VolcengineSeedV3", "parse", e))?; if let Some(error) = value.get("error").and_then(Value::as_str) { return Err(stage_failure("VolcengineSeedV3", "provider_response", provider_failure("火山 Seed v3", &value.get("code").and_then(Value::as_i64).unwrap_or_default().to_string(), error))); } let code = value.get("code").and_then(Value::as_i64).unwrap_or_default(); if code != 0 && code != 1000 { return Err(stage_failure("VolcengineSeedV3", "provider_response", provider_failure("火山 Seed v3", &code.to_string(), value.get("message").and_then(Value::as_str).unwrap_or_default()))); } if !ready { ready = true; emit(&app, SttEvent::Ready { session_id: session.clone() }); for (sequence, pcm) in pending.drain(..) { if let Some((_previous_sequence, previous_pcm)) = held_audio.replace((sequence, pcm)) { let compressed = seed_v3_audio(&previous_pcm).map_err(|e| stage_failure("VolcengineSeedV3", "send_audio", e))?; let frame = seed_v3_audio_frame(false, &compressed); write.send(Message::Binary(frame.into())).await.map_err(|e| stage_failure("VolcengineSeedV3", "send_audio", e.to_string()))?; } } if finishing && !finish_sent { let (_sequence, pcm) = held_audio.take().unwrap_or_default(); let compressed = seed_v3_audio(&pcm).map_err(|e| stage_failure("VolcengineSeedV3", "finish", e))?; let frame = seed_v3_audio_frame(true, &compressed); write.send(Message::Binary(frame.into())).await.map_err(|e| stage_failure("VolcengineSeedV3", "finish", e.to_string()))?; finish_sent = true; } } if let Some(result_text) = value.pointer("/result/text").and_then(Value::as_str) { last_text = result_text.to_string(); emit(&app, SttEvent::Partial { session_id: session.clone(), text: last_text.clone() }); } let completed = value.get("is_last_package").and_then(Value::as_bool).unwrap_or(false) || value.get("_last").and_then(Value::as_bool).unwrap_or(false); if finishing && completed { if !last_text.is_empty() { emit(&app, SttEvent::Final { session_id: session.clone(), text: last_text.clone() }); } let _ = write.close().await; return Ok(()); } },
            else => return if finishing && finish_sent { if !last_text.is_empty() { emit(&app, SttEvent::Final { session_id: session.clone(), text: last_text.clone() }); } Ok(()) } else { Err(stage_failure("VolcengineSeedV3", "close", "连接意外关闭")) },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn websocket_request_uses_seed_v3_connection_headers() {
        let config = serde_json::from_value(json!({
            "websocketUrl": "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async",
            "appId": "app-id",
            "accessToken": "access-token",
            "resourceId": "resource-id"
        }))
        .expect("config map");
        let request = seed_v3_websocket_request(&config, "connect-id").expect("v3 request");
        assert_eq!(
            request.uri().to_string(),
            "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async"
        );
        assert_eq!(request.headers()["X-Api-App-Key"], "app-id");
        assert_eq!(request.headers()["X-Api-Access-Key"], "access-token");
        assert_eq!(request.headers()["X-Api-Resource-Id"], "resource-id");
        assert_eq!(request.headers()["X-Api-Connect-Id"], "connect-id");
        assert!(!request.headers().contains_key("X-Api-Request-Id"));
    }

    #[test]
    fn websocket_handshake_errors_keep_their_result_category() {
        for (status, expected) in [
            (400, "protocol_failed:"),
            (401, "authentication_failed:"),
            (403, "authentication_failed:"),
            (500, "network_failed:"),
            (503, "network_failed:"),
        ] {
            let response = tokio_tungstenite::tungstenite::http::Response::builder()
                .status(status)
                .body(None)
                .expect("HTTP response");
            let failure = seed_v3_connect_failure(WebSocketError::Http(Box::new(response)));
            assert!(
                failure.starts_with(expected),
                "HTTP {status} classified as {failure:?}"
            );
            assert!(!failure.contains("access-token"));
        }

        let failure = seed_v3_connect_failure(WebSocketError::ConnectionClosed);
        assert!(failure.starts_with("network_failed:"));
    }

    #[test]
    fn websocket_request_uses_configured_endpoint() {
        let config = serde_json::from_value(json!({
            "websocketUrl": "wss://example.com/custom-v3",
            "appId": "app-id",
            "accessToken": "access-token",
            "resourceId": "resource-id"
        }))
        .expect("config map");
        let request = seed_v3_websocket_request(&config, "connect-id").expect("v3 request");
        assert_eq!(request.uri().to_string(), "wss://example.com/custom-v3");
    }

    #[test]
    fn audio_frames_rely_on_server_assigned_sequences() {
        let audio = seed_v3_audio_frame(false, &[1, 2]);
        assert_eq!(&audio[..4], &[0x11, 0x20, 0x01, 0x00]);
        assert_eq!(&audio[4..8], &2_u32.to_be_bytes());
        assert_eq!(&audio[8..], &[1, 2]);
        let finish = seed_v3_audio_frame(true, &[3, 4]);
        assert_eq!(&finish[..4], &[0x11, 0x22, 0x01, 0x00]);
        assert_eq!(&finish[4..8], &2_u32.to_be_bytes());
        assert_eq!(&finish[8..], &[3, 4]);
        let start = seed_v3_frame(1, 0, 1, &[1, 2]);
        assert_eq!(&start[..4], &[0x11, 0x10, 0x11, 0x00]);
    }

    #[test]
    fn start_request_uses_seed_v3_full_result_options() {
        let request = seed_v3_start_request("fixture-session");
        assert_eq!(request.pointer("/audio/format"), Some(&json!("pcm")));
        assert_eq!(request.pointer("/audio/rate"), Some(&json!(16000)));
        assert_eq!(
            request.pointer("/request/model_name"),
            Some(&json!("bigmodel"))
        );
        assert_eq!(
            request.pointer("/request/show_utterances"),
            Some(&json!(true))
        );
        assert_eq!(
            request.pointer("/request/result_type"),
            Some(&json!("full"))
        );
    }
}
