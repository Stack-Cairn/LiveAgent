use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{Arc, LazyLock, Mutex},
};
use tauri::{AppHandle, Emitter, Runtime, State};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

mod aliyun_dashscope;
mod baidu_cloud;
mod tencent_cloud;
mod volcengine_seed_v3;
mod volcengine_v2;

#[derive(Debug, Clone)]
pub enum SttCommand {
    Audio { sequence: u32, pcm: Vec<u8> },
    Finish,
    Cancel,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SttEvent {
    Ready {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    Partial {
        #[serde(rename = "sessionId")]
        session_id: String,
        text: String,
    },
    Final {
        #[serde(rename = "sessionId")]
        session_id: String,
        text: String,
    },
    Error {
        #[serde(rename = "sessionId")]
        session_id: String,
        code: String,
        message: String,
    },
    Closed {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
}

impl SttEvent {
    fn session_id(&self) -> &str {
        match self {
            Self::Ready { session_id }
            | Self::Partial { session_id, .. }
            | Self::Final { session_id, .. }
            | Self::Error { session_id, .. }
            | Self::Closed { session_id } => session_id,
        }
    }
}

static TEST_OBSERVERS: LazyLock<Mutex<HashMap<String, mpsc::UnboundedSender<SttEvent>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn ensure_stt_crypto_provider() {
    crate::services::gateway::ensure_rustls_crypto_provider();
}

struct ActiveSttSession {
    sender: mpsc::Sender<SttCommand>,
    next_sequence: u32,
}

#[derive(Default)]
pub struct SttManager {
    sessions: Arc<Mutex<HashMap<String, ActiveSttSession>>>,
}

impl SttManager {
    fn emit<R: Runtime>(app: &AppHandle<R>, event: SttEvent) {
        let session_id = event.session_id().to_string();
        let _ = app.emit("stt:event", event.clone());
        if let Ok(observers) = TEST_OBSERVERS.lock() {
            if let Some(observer) = observers.get(&session_id) {
                let _ = observer.send(event);
            }
        }
    }
    pub async fn start<R: Runtime>(
        &self,
        app: AppHandle<R>,
        session_id: String,
        provider: String,
    ) -> Result<(), String> {
        self.start_observed(app, session_id, provider, None).await
    }
    async fn start_observed<R: Runtime>(
        &self,
        app: AppHandle<R>,
        session_id: String,
        provider: String,
        observer: Option<mpsc::UnboundedSender<SttEvent>>,
    ) -> Result<(), String> {
        // Desktop STT is independent of the Gateway connection, so it must
        // initialize rustls before any provider WebSocket is opened.
        ensure_stt_crypto_provider();
        let config = crate::commands::settings::load_stt_provider_runtime(&provider)?;
        let secrets = config.clone();
        let (tx, rx) = mpsc::channel(64);
        let mut sessions_guard = self
            .sessions
            .lock()
            .map_err(|_| "STT session lock poisoned")?;
        if sessions_guard.contains_key(&session_id) {
            return Err("STT session already exists".to_string());
        }
        sessions_guard.insert(
            session_id.clone(),
            ActiveSttSession {
                sender: tx,
                next_sequence: 0,
            },
        );
        drop(sessions_guard);
        if let Some(observer) = observer {
            TEST_OBSERVERS
                .lock()
                .map_err(|_| "STT test observer lock poisoned")?
                .insert(session_id.clone(), observer);
        }
        let sessions = self.sessions.clone();
        tokio::spawn(async move {
            let result = match provider.as_str() {
                "aliyun_dashscope" => {
                    aliyun_dashscope::run(app.clone(), session_id.clone(), config, rx).await
                }
                "tencent_cloud" => {
                    tencent_cloud::run(app.clone(), session_id.clone(), config, rx).await
                }
                "volcengine_v2" => {
                    volcengine_v2::run(app.clone(), session_id.clone(), config, rx).await
                }
                "volcengine_seed_v3" => {
                    volcengine_seed_v3::run(app.clone(), session_id.clone(), config, rx).await
                }
                "baidu_cloud" => {
                    baidu_cloud::run(app.clone(), session_id.clone(), config, rx).await
                }
                _ => Err("未知 STT 供应商".to_string()),
            };
            if let Err(message) = result {
                let safe_message = sanitize_error(&message, &secrets);
                let event = SttEvent::Error {
                    session_id: session_id.clone(),
                    code: classify_test_error(&safe_message).into(),
                    message: safe_message,
                };
                Self::emit(&app, event.clone());
            }
            let closed = SttEvent::Closed {
                session_id: session_id.clone(),
            };
            Self::emit(&app, closed.clone());
            if let Ok(mut observers) = TEST_OBSERVERS.lock() {
                observers.remove(&session_id);
            }
            if let Ok(mut all) = sessions.lock() {
                all.remove(&session_id);
            }
        });
        Ok(())
    }
    pub async fn send(&self, session_id: &str, command: SttCommand) -> Result<(), String> {
        let tx = {
            let mut sessions = self
                .sessions
                .lock()
                .map_err(|_| "STT session lock poisoned")?;
            let active = sessions
                .get_mut(session_id)
                .ok_or_else(|| "STT session 不存在".to_string())?;
            if let SttCommand::Audio { sequence, .. } = &command {
                if *sequence != active.next_sequence {
                    return Err("STT 音频序号不连续".to_string());
                }
                active.next_sequence = active
                    .next_sequence
                    .checked_add(1)
                    .ok_or_else(|| "STT 音频序号溢出".to_string())?;
            }
            active.sender.clone()
        };
        tx.send(command)
            .await
            .map_err(|_| "STT session 已关闭".to_string())
    }
    pub async fn cancel(&self, session_id: &str) -> Result<(), String> {
        self.send(session_id, SttCommand::Cancel).await
    }
}

#[tauri::command]
pub async fn stt_start(
    app: AppHandle,
    manager: State<'_, Arc<SttManager>>,
    session_id: String,
    provider: String,
) -> Result<(), String> {
    manager.start(app, session_id, provider).await
}

#[tauri::command]
pub async fn stt_send_audio(
    manager: State<'_, Arc<SttManager>>,
    session_id: String,
    sequence: u32,
    pcm: Vec<u8>,
) -> Result<(), String> {
    manager
        .send(&session_id, SttCommand::Audio { sequence, pcm })
        .await
}

#[tauri::command]
pub async fn stt_stop(
    manager: State<'_, Arc<SttManager>>,
    session_id: String,
) -> Result<(), String> {
    manager.send(&session_id, SttCommand::Finish).await
}

#[tauri::command]
pub async fn stt_cancel(
    manager: State<'_, Arc<SttManager>>,
    session_id: String,
) -> Result<(), String> {
    manager.cancel(&session_id).await
}

#[tauri::command]
#[cfg(target_os = "macos")]
pub async fn stt_request_microphone_permission(app: AppHandle) -> Result<(), String> {
    crate::services::stt::macos::request_microphone_permission(app).await
}

#[tauri::command]
#[cfg(not(target_os = "macos"))]
pub async fn stt_request_microphone_permission(_app: AppHandle) -> Result<(), String> {
    Ok(())
}

#[derive(Serialize)]
pub struct SttTestResponse {
    result: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

fn classify_test_error(message: &str) -> &'static str {
    let lower = message.to_ascii_lowercase();
    if lower.contains("no valid speeches")
        || lower.contains("no speech")
        || lower.contains("未检测到有效语音")
        || lower.contains("未发现有效语音")
        || lower.contains("3301")
        || lower.contains("-3005")
        || lower.contains("1013")
    {
        "connected_no_speech"
    } else if lower.starts_with("timeout:")
        || lower.contains("超时")
        || lower.contains("timeout")
        || lower.contains("deadline")
    {
        "timeout"
    } else if lower.starts_with("authentication_failed:")
        || lower.contains("authentication")
        || lower.contains("鉴权")
        || lower.contains("认证")
        || lower.contains("api key")
        || lower.contains("appkey")
        || lower.contains("token")
        || lower.contains("appid")
        || lower.contains("unauthorized")
        || lower.contains("forbidden")
        || lower.contains("http error: 401")
        || lower.contains("http error: 403")
    {
        "authentication_failed"
    } else if lower.starts_with("network_failed:")
        || lower.contains("网络")
        || lower.contains("network")
        || lower.contains("dns")
        || lower.contains("connection refused")
    {
        "network_failed"
    } else {
        "protocol_failed"
    }
}

fn safe_test_message(message: &str) -> String {
    static URL: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"(?i)\b(?:wss?|https?)://\S+").expect("valid STT URL redaction regex")
    });
    URL.replace_all(message, "[provider endpoint]")
        .chars()
        .take(240)
        .collect()
}

fn connection_test_requires_audio(provider: &str) -> bool {
    provider == "baidu_cloud"
}

#[tauri::command]
pub async fn settings_test_stt(
    app: AppHandle,
    manager: State<'_, Arc<SttManager>>,
    provider: String,
) -> Result<SttTestResponse, String> {
    test_stt_provider(app, manager.inner(), provider).await
}

async fn test_stt_provider<R: Runtime>(
    app: AppHandle<R>,
    manager: &SttManager,
    provider: String,
) -> Result<SttTestResponse, String> {
    let requires_audio_probe = connection_test_requires_audio(&provider);
    let session_id = format!("test-{}", uuid::Uuid::new_v4());
    let (events_tx, mut events_rx) = mpsc::unbounded_channel();
    manager
        .start_observed(app, session_id.clone(), provider, Some(events_tx))
        .await?;
    let (result, message) = async {
        let mut ready = false;
        let mut finish_sent = false;
        let mut sequence = 0_u32;
        let mut recognized = false;
        let ready_deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
        let mut finish_deadline = None;
        let mut interval = tokio::time::interval(std::time::Duration::from_millis(100));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            let phase_deadline = if !ready {
                Some(ready_deadline)
            } else if finish_sent {
                finish_deadline
            } else {
                None
            };
            tokio::select! {
                biased;
                event = events_rx.recv() => match event {
                    Some(SttEvent::Error { message, .. }) => {
                        let result = classify_test_error(&message);
                        return if result == "connected_no_speech" && finish_sent {
                            (result, None)
                        } else {
                            (result, Some(safe_test_message(&message)))
                        };
                    }
                    Some(SttEvent::Ready { .. }) if !ready => {
                        ready = true;
                        // PlanForDesktop treats a provider-specific ready state as
                        // sufficient proof that configuration and authentication work.
                        // Baidu has no server READY event, so its adapter emits ready
                        // after START and still needs the synthetic-audio probe below.
                        if !requires_audio_probe {
                            let _ = manager.cancel(&session_id).await;
                            return ("connected", None);
                        }
                    }
                    Some(SttEvent::Partial { text, .. } | SttEvent::Final { text, .. }) => {
                        recognized |= !text.trim().is_empty();
                    }
                    Some(SttEvent::Closed { .. }) if ready && finish_sent => {
                        return if recognized { ("connected", None) } else { ("connected_no_speech", None) };
                    }
                    Some(SttEvent::Closed { .. }) => {
                        return (
                            "protocol_failed",
                            Some("供应商在完成连接测试前关闭了会话".to_string()),
                        );
                    }
                    Some(_) => {}
                    None => {
                        return (
                            "protocol_failed",
                            Some("供应商连接测试未返回结果".to_string()),
                        );
                    }
                },
                _ = interval.tick(), if ready && !finish_sent => {
                    let result = if sequence < 10 {
                        let current = sequence;
                        sequence += 1;
                        manager.send(
                            &session_id,
                            SttCommand::Audio { sequence: current, pcm: vec![0; 3_200] },
                        ).await
                    } else {
                        finish_sent = true;
                        finish_deadline = Some(
                            tokio::time::Instant::now() + std::time::Duration::from_secs(5),
                        );
                        manager.send(&session_id, SttCommand::Finish).await
                    };
                    if let Err(message) = result {
                        let result = classify_test_error(&message);
                        return (result, Some(safe_test_message(&message)));
                    }
                },
                _ = tokio::time::sleep_until(
                    phase_deadline.unwrap_or(
                        ready_deadline + std::time::Duration::from_secs(60),
                    ),
                ), if phase_deadline.is_some() => {
                    let message = if ready {
                        "供应商已连接，但等待结束确认超时"
                    } else {
                        "等待供应商进入可发送音频状态超时"
                    };
                    return ("timeout", Some(message.to_string()));
                },
            }
        }
    }
    .await;
    if result == "timeout" {
        let _ = manager.cancel(&session_id).await;
    }
    Ok(SttTestResponse { result, message })
}

#[cfg(target_os = "macos")]
mod macos {
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeAudio};
    use std::sync::{Arc, Mutex};
    use tauri::AppHandle;

    pub async fn request_microphone_permission(app: AppHandle) -> Result<(), String> {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let sender_cell = Arc::new(Mutex::new(Some(sender)));
        let sender_for_main = sender_cell.clone();
        app.run_on_main_thread(move || {
            let send_result = |result| {
                if let Ok(mut sender) = sender_for_main.lock() {
                    if let Some(sender) = sender.take() {
                        let _ = sender.send(result);
                    }
                }
            };
            let media_type = unsafe { AVMediaTypeAudio.as_ref() };
            let Some(media_type) = media_type else {
                send_result(Err("macOS 音频媒体类型不可用".to_string()));
                return;
            };
            let status = unsafe { AVCaptureDevice::authorizationStatusForMediaType(media_type) };
            match status {
                AVAuthorizationStatus::Authorized => {
                    send_result(Ok(()));
                }
                AVAuthorizationStatus::Denied => {
                    send_result(Err("麦克风权限已拒绝，请在系统设置中允许访问".to_string()));
                }
                AVAuthorizationStatus::Restricted => {
                    send_result(Err("麦克风权限受系统限制".to_string()));
                }
                AVAuthorizationStatus::NotDetermined => {
                    let sender_for_callback = sender_cell.clone();
                    let callback = RcBlock::new(move |granted: Bool| {
                        let result = if granted.as_bool() {
                            Ok(())
                        } else {
                            Err("麦克风权限被拒绝".to_string())
                        };
                        if let Ok(mut sender) = sender_for_callback.lock() {
                            if let Some(sender) = sender.take() {
                                let _ = sender.send(result);
                            }
                        }
                    });
                    unsafe {
                        AVCaptureDevice::requestAccessForMediaType_completionHandler(
                            media_type, &callback,
                        )
                    };
                }
                _ => {
                    send_result(Err("未知的 macOS 麦克风权限状态".to_string()));
                }
            }
        })
        .map_err(|error| format!("无法调度 macOS 麦克风权限请求: {error}"))?;
        receiver
            .await
            .map_err(|_| "macOS 麦克风权限请求未返回".to_string())?
    }
}

fn text(config: &serde_json::Map<String, serde_json::Value>, key: &str) -> String {
    config
        .get(key)
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn websocket_endpoint(
    config: &serde_json::Map<String, serde_json::Value>,
    fallback: &str,
) -> Result<String, String> {
    let configured = text(config, "websocketUrl");
    let endpoint = if configured.is_empty() {
        fallback.to_string()
    } else {
        configured
    };
    let request = endpoint
        .as_str()
        .into_client_request()
        .map_err(|_| "STT WebSocket 地址无效".to_string())?;
    let has_user_info = request
        .uri()
        .authority()
        .is_some_and(|authority| authority.as_str().contains('@'));
    if request.uri().scheme_str() != Some("wss") || request.uri().host().is_none() || has_user_info
    {
        return Err("STT WebSocket 地址必须是完整的 wss:// 地址".to_string());
    }
    Ok(endpoint)
}

fn provider_failure(provider: &str, code: &str, message: &str) -> String {
    let detail = match (code.trim(), message.trim()) {
        ("", "") => "供应商拒绝了请求".to_string(),
        ("", message) => message.to_string(),
        (code, "") => code.to_string(),
        (code, message) => format!("{code}: {message}"),
    };
    let lower = detail.to_ascii_lowercase();
    let category = if [
        "auth",
        "unauthor",
        "forbidden",
        "api key",
        "access key",
        "token",
        "signature",
        "secret",
        "鉴权",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
    {
        "authentication_failed"
    } else {
        "protocol_failed"
    };
    format!("{category}: {provider} 拒绝了请求（{detail}）")
}

/// Keep the provider and lifecycle stage visible in the UI while leaving
/// credentials to the manager's existing redaction pass.
pub(crate) fn stage_failure(provider: &str, stage: &str, message: impl AsRef<str>) -> String {
    format!("[{provider}/{stage}] {}", message.as_ref().trim())
}

pub(crate) fn sanitize_error(
    message: &str,
    config: &serde_json::Map<String, serde_json::Value>,
) -> String {
    [
        "apiKey",
        "secretId",
        "secretKey",
        "accessToken",
        "baiduApiKey",
    ]
    .into_iter()
    .fold(message.to_string(), |sanitized, field| {
        let secret = config
            .get(field)
            .and_then(|value| value.as_str())
            .filter(|value| !value.is_empty());
        match secret {
            Some(secret) => sanitized.replace(secret, "[redacted]"),
            None => sanitized,
        }
    })
}

fn emit<R: Runtime>(app: &AppHandle<R>, event: SttEvent) {
    SttManager::emit(app, event);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn live_audio_pcm() -> Vec<u8> {
        let Ok(path) = std::env::var("LIVEAGENT_STT_LIVE_AUDIO_FILE") else {
            return vec![0; 30_720];
        };
        let wave = std::fs::read(path).expect("read live STT WAVE fixture");
        assert!(wave.starts_with(b"RIFF") && wave.get(8..12) == Some(b"WAVE"));
        let mut offset = 12;
        while offset + 8 <= wave.len() {
            let chunk_id = &wave[offset..offset + 4];
            let chunk_len = u32::from_le_bytes(
                wave[offset + 4..offset + 8]
                    .try_into()
                    .expect("WAVE chunk length"),
            ) as usize;
            let start = offset + 8;
            let end = start.checked_add(chunk_len).expect("WAVE chunk overflow");
            assert!(end <= wave.len(), "WAVE chunk exceeds file length");
            if chunk_id == b"data" {
                let mut pcm = wave[start..end].to_vec();
                pcm.truncate(160_000); // Five seconds at 16 kHz mono PCM16.
                assert!(!pcm.is_empty() && pcm.len() % 2 == 0);
                return pcm;
            }
            offset = end + (chunk_len % 2);
        }
        panic!("live STT WAVE fixture has no data chunk");
    }

    #[test]
    fn runtime_events_use_frontend_session_id_field() {
        let events = [
            SttEvent::Ready {
                session_id: "session-1".to_string(),
            },
            SttEvent::Partial {
                session_id: "session-1".to_string(),
                text: "partial".to_string(),
            },
            SttEvent::Final {
                session_id: "session-1".to_string(),
                text: "final".to_string(),
            },
            SttEvent::Error {
                session_id: "session-1".to_string(),
                code: "protocol_failed".to_string(),
                message: "failure".to_string(),
            },
            SttEvent::Closed {
                session_id: "session-1".to_string(),
            },
        ];
        for event in events {
            let value = serde_json::to_value(event).expect("serialize STT runtime event");
            assert_eq!(
                value.get("sessionId").and_then(|value| value.as_str()),
                Some("session-1")
            );
            assert!(value.get("session_id").is_none());
        }
    }

    #[test]
    fn connection_test_preserves_adapter_error_categories() {
        assert_eq!(
            classify_test_error("authentication_failed: invalid appkey"),
            "authentication_failed"
        );
        assert_eq!(
            classify_test_error("network_failed: connection refused"),
            "network_failed"
        );
        assert_eq!(
            classify_test_error("protocol_failed: malformed response"),
            "protocol_failed"
        );
    }

    #[test]
    fn only_baidu_connection_test_requires_synthetic_audio() {
        assert!(connection_test_requires_audio("baidu_cloud"));
        for provider in [
            "aliyun_dashscope",
            "tencent_cloud",
            "volcengine_v2",
            "volcengine_seed_v3",
        ] {
            assert!(!connection_test_requires_audio(provider));
        }
    }

    #[test]
    fn connection_test_diagnostic_redacts_provider_urls() {
        let diagnostic = safe_test_message(
            "request wss://example.invalid/asr?secretid=id&signature=signature failed",
        );
        assert_eq!(diagnostic, "request [provider endpoint] failed");
        assert!(!diagnostic.contains("signature"));
    }

    #[test]
    fn stt_installs_tls_crypto_without_a_gateway_connection() {
        ensure_stt_crypto_provider();
        assert!(rustls::crypto::CryptoProvider::get_default().is_some());
    }

    #[tokio::test]
    async fn configured_desktop_providers_live() {
        if std::env::var("LIVEAGENT_STT_LIVE").as_deref() != Ok("1") {
            return;
        }
        let app = tauri::test::mock_app();
        let manager = SttManager::default();
        let mut tested = 0;
        for provider in [
            "aliyun_dashscope",
            "tencent_cloud",
            "volcengine_v2",
            "volcengine_seed_v3",
            "baidu_cloud",
        ] {
            if crate::commands::settings::load_stt_provider_runtime(provider).is_err() {
                continue;
            }
            tested += 1;
            let response = test_stt_provider(app.handle().clone(), &manager, provider.to_string())
                .await
                .expect("run live desktop STT probe");
            eprintln!(
                "{provider}: result={} message={}",
                response.result,
                response.message.as_deref().unwrap_or("")
            );
            assert!(
                matches!(response.result, "connected" | "connected_no_speech"),
                "{provider} live probe failed: {:?}",
                response.message
            );
        }
        assert!(
            tested > 0,
            "desktop STT settings contain no configured providers"
        );
    }

    #[tokio::test]
    async fn configured_desktop_providers_audio_roundtrip_live() {
        if std::env::var("LIVEAGENT_STT_LIVE_AUDIO").as_deref() != Ok("1") {
            return;
        }
        let app = tauri::test::mock_app();
        let manager = SttManager::default();
        let pcm = live_audio_pcm();
        let require_transcript = std::env::var_os("LIVEAGENT_STT_LIVE_AUDIO_FILE").is_some();
        let mut tested = 0;
        for provider in [
            "aliyun_dashscope",
            "tencent_cloud",
            "volcengine_v2",
            "volcengine_seed_v3",
            "baidu_cloud",
        ] {
            if crate::commands::settings::load_stt_provider_runtime(provider).is_err() {
                continue;
            }
            tested += 1;
            let session_id = format!("live-audio-{}", uuid::Uuid::new_v4());
            let (events_tx, mut events_rx) = mpsc::unbounded_channel();
            manager
                .start_observed(
                    app.handle().clone(),
                    session_id.clone(),
                    provider.to_string(),
                    Some(events_tx),
                )
                .await
                .expect("start live STT audio roundtrip");
            let outcome = tokio::time::timeout(std::time::Duration::from_secs(20), async {
                let mut sent = false;
                let mut recognized = false;
                while let Some(event) = events_rx.recv().await {
                    match event {
                        SttEvent::Ready { .. } if !sent => {
                            sent = true;
                            let chunks = pcm.chunks(3_200).collect::<Vec<_>>();
                            for (sequence, chunk) in chunks.iter().enumerate() {
                                if let Err(send_error) = manager
                                    .send(
                                        &session_id,
                                        SttCommand::Audio {
                                            sequence: sequence as u32,
                                            pcm: chunk.to_vec(),
                                        },
                                    )
                                    .await
                                {
                                    let mut detail = send_error;
                                    while let Some(event) = events_rx.recv().await {
                                        match event {
                                            SttEvent::Error { message, .. } => {
                                                detail.push_str("; provider: ");
                                                detail.push_str(&message);
                                            }
                                            SttEvent::Closed { .. } => return Err(detail),
                                            _ => {}
                                        }
                                    }
                                    return Err(detail);
                                }
                                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                            }
                            manager
                                .send(
                                    &session_id,
                                    SttCommand::Audio {
                                        sequence: chunks.len() as u32,
                                        pcm: vec![0; 12_800],
                                    },
                                )
                                .await
                                .expect("send live STT trailing silence");
                            manager
                                .send(&session_id, SttCommand::Finish)
                                .await
                                .expect("finish live STT audio roundtrip");
                        }
                        SttEvent::Partial { ref text, .. } | SttEvent::Final { ref text, .. } => {
                            recognized |= !text.trim().is_empty();
                        }
                        SttEvent::Error { message, .. } => return Err(message),
                        SttEvent::Closed { .. } if sent => return Ok(recognized),
                        SttEvent::Closed { .. } => {
                            return Err("provider closed before ready".to_string());
                        }
                        _ => {}
                    }
                }
                Err("provider event stream ended before closed".to_string())
            })
            .await;
            match outcome {
                Ok(Ok(recognized)) if require_transcript && !recognized => {
                    panic!("{provider} audio roundtrip returned no transcript")
                }
                Ok(Ok(recognized)) => {
                    eprintln!("{provider}: audio_roundtrip=connected transcript={recognized}")
                }
                Ok(Err(message)) => panic!("{provider} audio roundtrip failed: {message}"),
                Err(_) => {
                    let _ = manager.cancel(&session_id).await;
                    panic!("{provider} audio roundtrip timed out");
                }
            }
        }
        assert!(
            tested > 0,
            "desktop STT settings contain no configured providers"
        );
    }
}
