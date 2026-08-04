use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use agent_core::commands::settings::RemoteSettingsPayload;

use super::{
    GatewayStatusSnapshot, GATEWAY_CHAT_RUNTIME_WAKE_REQUEST_PREFIX, GATEWAY_RECONNECT_MAX,
    GATEWAY_RECONNECT_MIN, GATEWAY_RECONNECT_STABLE_AFTER,
};

pub(crate) fn is_chat_runtime_wake_request_id(request_id: &str) -> bool {
    request_id
        .trim()
        .starts_with(GATEWAY_CHAT_RUNTIME_WAKE_REQUEST_PREFIX)
}

pub(crate) fn gateway_connection_stale_after(config: &RemoteSettingsPayload) -> Duration {
    Duration::from_secs(
        config
            .heartbeat_interval
            .clamp(10, 60)
            .saturating_add(20)
            .min(60),
    )
}

pub(crate) fn gateway_connection_needs_restart(
    status: &GatewayStatusSnapshot,
    config: &RemoteSettingsPayload,
    now_unix_seconds: i64,
) -> bool {
    if !config.enabled || config.gateway_url.trim().is_empty() || config.token.trim().is_empty() {
        return false;
    }
    if !status.online {
        return true;
    }
    let Some(last_heartbeat) = status.last_heartbeat else {
        return true;
    };
    let stale_after =
        i64::try_from(gateway_connection_stale_after(config).as_secs()).unwrap_or(i64::MAX);
    now_unix_seconds.saturating_sub(last_heartbeat) > stale_after
}

pub(crate) fn gateway_reconnect_backoff(
    current: Duration,
    attempt_elapsed: Duration,
) -> (Duration, Duration) {
    let delay = if attempt_elapsed >= GATEWAY_RECONNECT_STABLE_AFTER {
        GATEWAY_RECONNECT_MIN
    } else {
        current.clamp(GATEWAY_RECONNECT_MIN, GATEWAY_RECONNECT_MAX)
    };
    (delay, std::cmp::min(delay * 2, GATEWAY_RECONNECT_MAX))
}

pub(crate) fn optional_proto_text(value: String) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

pub(crate) fn optional_proto_u16(value: u32) -> Option<u16> {
    if value == 0 {
        None
    } else {
        Some(value.min(u32::from(u16::MAX)) as u16)
    }
}

pub(crate) fn optional_proto_usize(value: u32) -> Option<usize> {
    (value > 0).then_some(value as usize)
}

pub(crate) fn now_unix_seconds() -> i64 {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| Duration::from_secs(0));
    i64::try_from(duration.as_secs()).unwrap_or(i64::MAX)
}

pub(crate) fn now_unix_millis() -> i64 {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| Duration::from_secs(0));
    i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
}

pub(crate) fn chat_run_ledger_now() -> (Instant, i64) {
    (Instant::now(), now_unix_millis())
}
