//! Desired tunnel state: the agent-side source of truth, persisted in the
//! settings DB (`tunnel_settings`) and mirrored to the gateway as
//! `TunnelDesiredState`.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::Emitter;
use uuid::Uuid;

use crate::commands::settings::open_db;
use crate::runtime::project_path::project_path_key as normalize_project_path_key;
use crate::services::gateway::{now_unix_seconds, proto};

use super::{
    tunnel_health_payload_from_proto, validate_tunnel_target_url, GatewayTunnelCreateInput,
    GatewayTunnelUpdateInput, TunnelHealthPayload, TunnelMutationError, TunnelStatePayload,
    TunnelStatusPayload, GATEWAY_TUNNEL_STATE_EVENT,
};

const TUNNEL_SETTINGS_TABLE: &str = "tunnel_settings";
const MAX_TUNNELS_PER_AGENT: usize = 5;
// The only Rust source of truth for allowed tunnel TTLs.
const TUNNEL_TTL_WHITELIST: [u32; 4] = [0, 900, 3600, 14400];
const TUNNEL_DEFAULT_TTL_SECONDS: u32 = 3600;
const TUNNEL_PROBE_THROTTLE: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredTunnelSpec {
    pub id: String,
    #[serde(default)]
    pub slug_hint: String,
    #[serde(default)]
    pub name: String,
    pub target_url: String,
    #[serde(default)]
    pub expires_at: i64,
    #[serde(default)]
    pub project_path_key: String,
    #[serde(default)]
    pub created_at: i64,
}

#[derive(Default)]
struct TunnelStoreState {
    specs: HashMap<String, StoredTunnelSpec>,
    revision: u64,
    local_health: HashMap<String, TunnelHealthPayload>,
    probe_checked_at: HashMap<String, Instant>,
    last_snapshot: Option<TunnelStatePayload>,
    gateway_unsupported: bool,
    publish_epoch: u64,
    snapshot_epoch: u64,
    /// Monotonic sequence stamped onto every emitted `TunnelStatePayload`.
    /// This is the only revision the frontend ever sees; neither the gateway
    /// process counter nor the local desired-state `revision` leaks through.
    emit_seq: u64,
}

pub struct TunnelStore {
    app_handle: tauri::AppHandle,
    state: Mutex<TunnelStoreState>,
}

impl TunnelStore {
    pub fn new(app_handle: tauri::AppHandle) -> Self {
        Self {
            app_handle,
            state: Mutex::new(TunnelStoreState::default()),
        }
    }

    fn lock_state(&self) -> Result<std::sync::MutexGuard<'_, TunnelStoreState>, String> {
        self.state
            .lock()
            .map_err(|_| "gateway tunnel store lock poisoned".to_string())
    }

    /// Loads persisted specs (dropping already-expired ones) into memory.
    pub async fn initialize(&self) -> Result<(), String> {
        let specs = load_tunnel_specs().await?;
        let expired = {
            let mut state = self.lock_state()?;
            for spec in specs {
                state.specs.entry(spec.id.clone()).or_insert(spec);
            }
            sweep_expired_specs(&mut state, now_unix_seconds())
        };
        if !expired.is_empty() {
            delete_tunnel_specs(expired).await?;
        }
        Ok(())
    }

    pub(super) fn prepare_create(
        &self,
        input: GatewayTunnelCreateInput,
    ) -> Result<StoredTunnelSpec, TunnelMutationError> {
        let state = self.lock_state().map_err(TunnelMutationError::internal)?;
        prepare_create_spec(&state, input, now_unix_seconds())
    }

    pub(super) fn prepare_update(
        &self,
        input: GatewayTunnelUpdateInput,
    ) -> Result<StoredTunnelSpec, TunnelMutationError> {
        let state = self.lock_state().map_err(TunnelMutationError::internal)?;
        prepare_update_spec(&state, input)
    }

    pub(super) fn commit_spec(&self, spec: StoredTunnelSpec) -> Result<(), String> {
        let mut state = self.lock_state()?;
        state.specs.insert(spec.id.clone(), spec);
        state.revision += 1;
        Ok(())
    }

    pub(super) fn remove_spec(&self, tunnel_id: &str) -> Result<Option<StoredTunnelSpec>, String> {
        let mut state = self.lock_state()?;
        let removed = state.specs.remove(tunnel_id.trim());
        if removed.is_some() {
            state.local_health.remove(tunnel_id.trim());
            state.probe_checked_at.remove(tunnel_id.trim());
            state.revision += 1;
        }
        Ok(removed)
    }

    pub(super) fn spec_exists(&self, tunnel_id: &str) -> Result<bool, String> {
        Ok(self.lock_state()?.specs.contains_key(tunnel_id.trim()))
    }

    /// Removes expired specs from memory and returns their ids so the caller
    /// can persist the deletions.
    pub(super) fn take_expired_specs(&self) -> Result<Vec<String>, String> {
        let mut state = self.lock_state()?;
        Ok(sweep_expired_specs(&mut state, now_unix_seconds()))
    }

    pub(super) fn desired_state(&self) -> Result<(Vec<proto::TunnelSpec>, u64), String> {
        let state = self.lock_state()?;
        let mut specs = state
            .specs
            .values()
            .filter(|spec| !spec_expired(spec, now_unix_seconds()))
            .cloned()
            .collect::<Vec<_>>();
        specs.sort_by(|a, b| {
            a.created_at
                .cmp(&b.created_at)
                .then_with(|| a.id.cmp(&b.id))
        });
        let tunnels = specs
            .into_iter()
            .map(|spec| proto::TunnelSpec {
                id: spec.id,
                slug_hint: spec.slug_hint,
                name: spec.name,
                target_url: spec.target_url,
                expires_at: spec.expires_at,
                project_path_key: spec.project_path_key,
            })
            .collect();
        Ok((tunnels, state.revision))
    }

    pub(super) fn begin_publish_watch(&self) -> Result<u64, String> {
        let mut state = self.lock_state()?;
        state.publish_epoch += 1;
        Ok(state.publish_epoch)
    }

    /// Marks the gateway as tunnel-unsupported when no snapshot has arrived
    /// since the given publish epoch. Returns true when the flag flipped on.
    pub(super) fn mark_gateway_unsupported_if_stale(&self, epoch: u64) -> Result<bool, String> {
        let mut state = self.lock_state()?;
        if state.snapshot_epoch >= epoch {
            return Ok(false);
        }
        state.gateway_unsupported = true;
        Ok(true)
    }

    pub(super) fn is_gateway_unsupported(&self) -> bool {
        self.lock_state()
            .map(|state| state.gateway_unsupported)
            .unwrap_or(false)
    }

    /// Applies a gateway snapshot: persist-worthy slug allocations are
    /// returned, the payload is cached, and the Tauri event is emitted.
    pub(super) fn record_snapshot(
        &self,
        snapshot: &proto::TunnelStateSnapshot,
    ) -> Result<Vec<StoredTunnelSpec>, String> {
        let payload = tunnel_state_payload_from_proto(snapshot);
        let changed = {
            let mut state = self.lock_state()?;
            let mut changed = Vec::new();
            for status in &snapshot.tunnels {
                let slug = status.slug.trim();
                if slug.is_empty() {
                    continue;
                }
                if let Some(spec) = state.specs.get_mut(status.id.trim()) {
                    if spec.slug_hint != slug {
                        spec.slug_hint = slug.to_string();
                        changed.push(spec.clone());
                    }
                }
            }
            state.gateway_unsupported = false;
            state.snapshot_epoch = state.publish_epoch;
            changed
        };
        self.publish(payload);
        Ok(changed)
    }

    pub(super) fn cached_state(&self) -> Option<TunnelStatePayload> {
        self.lock_state().ok()?.last_snapshot.clone()
    }

    pub(super) fn cache_and_emit(&self, payload: TunnelStatePayload) {
        self.publish(payload);
    }

    /// The single publish path for `gateway:tunnel-state`: stamps the payload
    /// with the next `emit_seq` (overwriting whatever placeholder revision
    /// the builder left) and caches it before emitting, so the initial
    /// `gateway_tunnel_state` pull and the event stream share one strictly
    /// monotonic revision domain regardless of whether the payload came from
    /// a gateway snapshot or a local rebuild.
    fn publish(&self, payload: TunnelStatePayload) {
        let payload = match self.lock_state() {
            Ok(mut state) => stamp_and_cache(&mut state, payload),
            Err(error) => {
                eprintln!("publish gateway tunnel state failed: {error}");
                return;
            }
        };
        self.emit_state(&payload);
    }

    fn emit_state(&self, payload: &TunnelStatePayload) {
        if let Err(error) = self
            .app_handle
            .emit(GATEWAY_TUNNEL_STATE_EVENT, payload.clone())
        {
            eprintln!("emit gateway tunnel state failed: {error}");
        }
    }

    /// Builds a snapshot from local desired specs for offline/unsupported
    /// rendering: slug/publicPath stay empty until the gateway allocates them.
    pub(super) fn build_local_state(
        &self,
        agent_online: bool,
    ) -> Result<TunnelStatePayload, String> {
        let state = self.lock_state()?;
        Ok(build_local_state_payload(
            &state,
            agent_online,
            now_unix_seconds(),
        ))
    }

    /// Returns `(tunnel_id, target_url)` pairs due for a local probe and
    /// stamps their throttle window. Explicit checks bypass the throttle.
    pub(super) fn claim_probe_targets(
        &self,
        tunnel_ids: Option<Vec<String>>,
        bypass_throttle: bool,
    ) -> Result<Vec<(String, String)>, String> {
        let mut state = self.lock_state()?;
        let now_unix = now_unix_seconds();
        let now = Instant::now();
        let candidate_ids = match tunnel_ids {
            Some(ids) => ids
                .into_iter()
                .map(|id| id.trim().to_string())
                .filter(|id| !id.is_empty())
                .collect::<Vec<_>>(),
            None => state.specs.keys().cloned().collect(),
        };
        let mut targets = Vec::new();
        for tunnel_id in candidate_ids {
            let Some(spec) = state.specs.get(&tunnel_id) else {
                continue;
            };
            if spec_expired(spec, now_unix) {
                continue;
            }
            if !bypass_throttle {
                let throttled = state
                    .probe_checked_at
                    .get(&tunnel_id)
                    .map(|checked_at| now.duration_since(*checked_at) < TUNNEL_PROBE_THROTTLE)
                    .unwrap_or(false);
                if throttled {
                    continue;
                }
            }
            let target_url = spec.target_url.clone();
            state.probe_checked_at.insert(tunnel_id.clone(), now);
            targets.push((tunnel_id, target_url));
        }
        Ok(targets)
    }

    pub(super) fn record_local_health(
        &self,
        results: &[(String, TunnelHealthPayload)],
    ) -> Result<(), String> {
        let mut state = self.lock_state()?;
        for (tunnel_id, health) in results {
            state.local_health.insert(tunnel_id.clone(), health.clone());
        }
        Ok(())
    }
}

/// Stamps the payload with the next emission sequence and caches it as the
/// latest snapshot. Runs with the store lock held, so interleaved gateway
/// snapshots and local rebuilds still receive strictly increasing revisions.
fn stamp_and_cache(
    state: &mut TunnelStoreState,
    mut payload: TunnelStatePayload,
) -> TunnelStatePayload {
    state.emit_seq += 1;
    payload.revision = state.emit_seq;
    state.last_snapshot = Some(payload.clone());
    payload
}

fn build_local_state_payload(
    state: &TunnelStoreState,
    agent_online: bool,
    now: i64,
) -> TunnelStatePayload {
    let mut specs = state
        .specs
        .values()
        .filter(|spec| !spec_expired(spec, now))
        .cloned()
        .collect::<Vec<_>>();
    specs.sort_by(|a, b| {
        a.created_at
            .cmp(&b.created_at)
            .then_with(|| a.id.cmp(&b.id))
    });
    let tunnels = specs
        .into_iter()
        .map(|spec| TunnelStatusPayload {
            local: state.local_health.get(&spec.id).cloned(),
            id: spec.id,
            slug: String::new(),
            name: spec.name,
            target_url: spec.target_url,
            public_path: String::new(),
            created_at: spec.created_at,
            expires_at: spec.expires_at,
            active_connections: 0,
            project_path_key: spec.project_path_key,
        })
        .collect();
    TunnelStatePayload {
        // Placeholder: `TunnelStore::publish` injects the real revision.
        revision: 0,
        agent_online,
        relay: None,
        tunnels,
        gateway_unsupported: state.gateway_unsupported.then_some(true),
    }
}

fn spec_expired(spec: &StoredTunnelSpec, now: i64) -> bool {
    spec.expires_at > 0 && spec.expires_at <= now
}

fn sweep_expired_specs(state: &mut TunnelStoreState, now: i64) -> Vec<String> {
    let expired = state
        .specs
        .values()
        .filter(|spec| spec_expired(spec, now))
        .map(|spec| spec.id.clone())
        .collect::<Vec<_>>();
    for tunnel_id in &expired {
        state.specs.remove(tunnel_id);
        state.local_health.remove(tunnel_id);
        state.probe_checked_at.remove(tunnel_id);
    }
    if !expired.is_empty() {
        state.revision += 1;
    }
    expired
}

fn prepare_create_spec(
    state: &TunnelStoreState,
    input: GatewayTunnelCreateInput,
    now: i64,
) -> Result<StoredTunnelSpec, TunnelMutationError> {
    let target = validate_tunnel_target_url(&input.target_url)
        .map_err(|error| TunnelMutationError::new("invalid_target", error))?;
    let ttl_seconds = normalize_tunnel_ttl(input.ttl_seconds)
        .map_err(|error| TunnelMutationError::new("invalid_ttl", error))?;
    let active = state
        .specs
        .values()
        .filter(|spec| !spec_expired(spec, now))
        .count();
    if active >= MAX_TUNNELS_PER_AGENT {
        return Err(TunnelMutationError::new(
            "limit_exceeded",
            format!("at most {MAX_TUNNELS_PER_AGENT} tunnels are allowed"),
        ));
    }
    Ok(StoredTunnelSpec {
        id: generate_tunnel_id(),
        slug_hint: String::new(),
        name: input.name.unwrap_or_default().trim().to_string(),
        target_url: target.url.to_string(),
        expires_at: tunnel_expires_at(ttl_seconds),
        project_path_key: normalize_project_path_key(&input.project_path_key.unwrap_or_default()),
        created_at: now,
    })
}

fn prepare_update_spec(
    state: &TunnelStoreState,
    input: GatewayTunnelUpdateInput,
) -> Result<StoredTunnelSpec, TunnelMutationError> {
    let tunnel_id = input.id.trim().to_string();
    if tunnel_id.is_empty() {
        return Err(TunnelMutationError::not_found());
    }
    let existing = state
        .specs
        .get(&tunnel_id)
        .ok_or_else(TunnelMutationError::not_found)?;
    let target = validate_tunnel_target_url(&input.target_url)
        .map_err(|error| TunnelMutationError::new("invalid_target", error))?;
    // ttlSeconds absent keeps the current expiry; present recomputes from now.
    let expires_at = match input.ttl_seconds {
        None => existing.expires_at,
        Some(ttl_seconds) => {
            let ttl_seconds = normalize_tunnel_ttl(Some(ttl_seconds))
                .map_err(|error| TunnelMutationError::new("invalid_ttl", error))?;
            tunnel_expires_at(ttl_seconds)
        }
    };
    Ok(StoredTunnelSpec {
        id: existing.id.clone(),
        slug_hint: existing.slug_hint.clone(),
        name: input.name.unwrap_or_default().trim().to_string(),
        target_url: target.url.to_string(),
        expires_at,
        project_path_key: normalize_project_path_key(&input.project_path_key.unwrap_or_default()),
        created_at: existing.created_at,
    })
}

fn normalize_tunnel_ttl(input: Option<u32>) -> Result<u32, String> {
    let ttl_seconds = input.unwrap_or(TUNNEL_DEFAULT_TTL_SECONDS);
    if TUNNEL_TTL_WHITELIST.contains(&ttl_seconds) {
        Ok(ttl_seconds)
    } else {
        Err("ttlSeconds must be one of 0, 900, 3600, or 14400".to_string())
    }
}

fn tunnel_expires_at(ttl_seconds: u32) -> i64 {
    if ttl_seconds == 0 {
        return 0;
    }
    now_unix_seconds() + i64::from(ttl_seconds)
}

fn generate_tunnel_id() -> String {
    let timestamp = chrono::Utc::now().format("%Y%m%d%H%M%S%f");
    format!("tun_{timestamp}_{}", random_url_token(8))
}

fn random_url_token(byte_count: usize) -> String {
    let bytes = Uuid::new_v4();
    let byte_count = byte_count.min(bytes.as_bytes().len());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&bytes.as_bytes()[..byte_count])
}

fn tunnel_state_payload_from_proto(snapshot: &proto::TunnelStateSnapshot) -> TunnelStatePayload {
    TunnelStatePayload {
        // Placeholder: `TunnelStore::publish` injects the real revision. The
        // gateway process counter lives in a different domain and must never
        // reach the frontend's monotonicity guard.
        revision: 0,
        agent_online: snapshot.agent_online,
        relay: snapshot
            .relay
            .as_ref()
            .map(tunnel_health_payload_from_proto),
        tunnels: snapshot
            .tunnels
            .iter()
            .map(|status| TunnelStatusPayload {
                id: status.id.clone(),
                slug: status.slug.clone(),
                name: status.name.clone(),
                target_url: status.target_url.clone(),
                public_path: status.public_path.clone(),
                created_at: status.created_at,
                expires_at: status.expires_at,
                active_connections: status.active_connections,
                project_path_key: status.project_path_key.clone(),
                local: status.local.as_ref().map(tunnel_health_payload_from_proto),
            })
            .collect(),
        gateway_unsupported: None,
    }
}

fn now_ms() -> i64 {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| Duration::from_secs(0));
    duration.as_millis() as i64
}

async fn load_tunnel_specs() -> Result<Vec<StoredTunnelSpec>, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_db()?;
        load_tunnel_specs_sync(&conn)
    })
    .await
    .map_err(|e| format!("load tunnel specs join failed: {e}"))?
}

pub(super) async fn persist_tunnel_spec(spec: StoredTunnelSpec) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_db()?;
        persist_tunnel_spec_sync(&conn, &spec)
    })
    .await
    .map_err(|e| format!("persist tunnel spec join failed: {e}"))?
}

pub(super) async fn delete_tunnel_specs(tunnel_ids: Vec<String>) -> Result<(), String> {
    if tunnel_ids.is_empty() {
        return Ok(());
    }
    tokio::task::spawn_blocking(move || {
        let conn = open_db()?;
        for tunnel_id in &tunnel_ids {
            delete_tunnel_spec_sync(&conn, tunnel_id)?;
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("delete tunnel specs join failed: {e}"))?
}

fn load_tunnel_specs_sync(conn: &Connection) -> Result<Vec<StoredTunnelSpec>, String> {
    let mut statement = conn
        .prepare(&format!(
            "SELECT tunnel_id, payload_json FROM {TUNNEL_SETTINGS_TABLE}"
        ))
        .map_err(|e| format!("read {TUNNEL_SETTINGS_TABLE} failed: {e}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| format!("read {TUNNEL_SETTINGS_TABLE} failed: {e}"))?;
    let mut specs = Vec::new();
    for row in rows {
        let (tunnel_id, payload_json) =
            row.map_err(|e| format!("read {TUNNEL_SETTINGS_TABLE} failed: {e}"))?;
        match serde_json::from_str::<StoredTunnelSpec>(&payload_json) {
            Ok(mut spec) => {
                if spec.id.trim().is_empty() {
                    spec.id = tunnel_id;
                }
                specs.push(spec);
            }
            Err(error) => {
                eprintln!("parse tunnel spec {tunnel_id} failed: {error}");
            }
        }
    }
    Ok(specs)
}

fn persist_tunnel_spec_sync(conn: &Connection, spec: &StoredTunnelSpec) -> Result<(), String> {
    let payload_json = serde_json::to_string(spec)
        .map_err(|e| format!("serialize tunnel spec {} failed: {e}", spec.id))?;
    conn.execute(
        &format!(
            "INSERT OR REPLACE INTO {TUNNEL_SETTINGS_TABLE} (tunnel_id, payload_json, updated_at) VALUES (?1, ?2, ?3)"
        ),
        params![spec.id, payload_json, now_ms()],
    )
    .map_err(|e| format!("write {TUNNEL_SETTINGS_TABLE} failed: {e}"))?;
    Ok(())
}

fn delete_tunnel_spec_sync(conn: &Connection, tunnel_id: &str) -> Result<(), String> {
    conn.execute(
        &format!("DELETE FROM {TUNNEL_SETTINGS_TABLE} WHERE tunnel_id = ?1"),
        params![tunnel_id],
    )
    .map_err(|e| format!("delete from {TUNNEL_SETTINGS_TABLE} failed: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        build_local_state_payload, generate_tunnel_id, normalize_tunnel_ttl, prepare_create_spec,
        prepare_update_spec, stamp_and_cache, tunnel_expires_at, tunnel_state_payload_from_proto,
        TunnelStoreState, TUNNEL_DEFAULT_TTL_SECONDS,
    };
    use crate::services::gateway::proto;
    use crate::services::tunnel::{GatewayTunnelCreateInput, GatewayTunnelUpdateInput};

    fn create_input(target_url: &str) -> GatewayTunnelCreateInput {
        GatewayTunnelCreateInput {
            target_url: target_url.to_string(),
            name: Some(" dev server ".to_string()),
            ttl_seconds: None,
            project_path_key: Some("/workspace/project".to_string()),
        }
    }

    #[test]
    fn emitted_revisions_stay_monotonic_across_snapshot_and_local_paths() {
        let mut state = TunnelStoreState::default();

        // The gateway process counter must never leak into the emitted
        // revision domain.
        let snapshot = proto::TunnelStateSnapshot {
            revision: 999,
            agent_online: true,
            ..Default::default()
        };
        let gateway_payload = tunnel_state_payload_from_proto(&snapshot);
        assert_eq!(gateway_payload.revision, 0, "builder leaves a placeholder");

        let first = stamp_and_cache(&mut state, gateway_payload.clone());
        let local_payload = build_local_state_payload(&state, false, 1_000);
        let second = stamp_and_cache(&mut state, local_payload);
        let third = stamp_and_cache(&mut state, gateway_payload);

        assert_eq!(first.revision, 1);
        assert_eq!(second.revision, 2);
        assert_eq!(third.revision, 3);
        assert_eq!(state.last_snapshot.as_ref().unwrap().revision, 3);
    }

    #[test]
    fn local_state_payload_reports_agent_offline() {
        let mut state = TunnelStoreState::default();
        let now = 1_000;
        let spec = prepare_create_spec(&state, create_input("http://localhost:3000"), now)
            .expect("create spec");
        state.specs.insert(spec.id.clone(), spec);

        let payload = build_local_state_payload(&state, false, now);
        assert!(!payload.agent_online);
        assert_eq!(payload.tunnels.len(), 1);
        assert!(payload.tunnels[0].slug.is_empty());
        assert_eq!(payload.revision, 0, "revision is assigned at publish time");
    }

    #[test]
    fn tunnel_ttl_allows_infinite_expiry() {
        assert_eq!(normalize_tunnel_ttl(Some(0)).unwrap(), 0);
        assert_eq!(tunnel_expires_at(0), 0);
        assert!(normalize_tunnel_ttl(Some(1)).is_err());
    }

    #[test]
    fn tunnel_ttl_defaults_when_absent() {
        assert_eq!(
            normalize_tunnel_ttl(None).unwrap(),
            TUNNEL_DEFAULT_TTL_SECONDS
        );
    }

    #[test]
    fn generated_tunnel_ids_are_prefixed_and_unique() {
        let first = generate_tunnel_id();
        let second = generate_tunnel_id();
        assert!(first.starts_with("tun_"), "{first}");
        assert_ne!(first, second);
    }

    #[test]
    fn create_spec_applies_defaults_and_validation() {
        let state = TunnelStoreState::default();
        let now = 1_000;

        let spec = prepare_create_spec(&state, create_input("http://localhost:3000"), now)
            .expect("create spec");
        assert_eq!(spec.name, "dev server");
        assert_eq!(spec.target_url, "http://localhost:3000/");
        assert_eq!(spec.created_at, now);
        assert!(spec.expires_at > 0, "default ttl should set an expiry");
        assert!(spec.slug_hint.is_empty());

        let invalid_target =
            prepare_create_spec(&state, create_input("http://example.com"), now).unwrap_err();
        assert_eq!(invalid_target.code, "invalid_target");

        let mut invalid_ttl_input = create_input("http://localhost:3000");
        invalid_ttl_input.ttl_seconds = Some(123);
        let invalid_ttl = prepare_create_spec(&state, invalid_ttl_input, now).unwrap_err();
        assert_eq!(invalid_ttl.code, "invalid_ttl");
    }

    #[test]
    fn create_spec_enforces_tunnel_limit() {
        let mut state = TunnelStoreState::default();
        let now = 1_000;
        for index in 0..5 {
            let spec =
                prepare_create_spec(&state, create_input("http://localhost:3000"), now).unwrap();
            state.specs.insert(format!("tun_{index}"), spec);
        }

        let over_limit =
            prepare_create_spec(&state, create_input("http://localhost:3000"), now).unwrap_err();
        assert_eq!(over_limit.code, "limit_exceeded");

        // Expired tunnels no longer count against the limit.
        state.specs.values_mut().next().unwrap().expires_at = now - 1;
        assert!(prepare_create_spec(&state, create_input("http://localhost:3000"), now).is_ok());
    }

    #[test]
    fn update_spec_keeps_expiry_when_ttl_absent() {
        let mut state = TunnelStoreState::default();
        let now = 1_000;
        let mut spec =
            prepare_create_spec(&state, create_input("http://localhost:3000"), now).unwrap();
        spec.expires_at = 4_242;
        let tunnel_id = spec.id.clone();
        state.specs.insert(tunnel_id.clone(), spec);

        let kept = prepare_update_spec(
            &state,
            GatewayTunnelUpdateInput {
                id: tunnel_id.clone(),
                target_url: "http://127.0.0.1:8080".to_string(),
                name: Some("renamed".to_string()),
                ttl_seconds: None,
                project_path_key: None,
            },
        )
        .expect("update spec");
        assert_eq!(kept.expires_at, 4_242);
        assert_eq!(kept.name, "renamed");
        assert_eq!(kept.target_url, "http://127.0.0.1:8080/");

        let recomputed = prepare_update_spec(
            &state,
            GatewayTunnelUpdateInput {
                id: tunnel_id,
                target_url: "http://127.0.0.1:8080".to_string(),
                name: None,
                ttl_seconds: Some(900),
                project_path_key: None,
            },
        )
        .expect("update spec with ttl");
        assert_ne!(recomputed.expires_at, 4_242);
        assert!(recomputed.expires_at > 0);

        let missing = prepare_update_spec(
            &state,
            GatewayTunnelUpdateInput {
                id: "tun_missing".to_string(),
                target_url: "http://127.0.0.1:8080".to_string(),
                name: None,
                ttl_seconds: None,
                project_path_key: None,
            },
        )
        .unwrap_err();
        assert_eq!(missing.code, "not_found");
    }
}
