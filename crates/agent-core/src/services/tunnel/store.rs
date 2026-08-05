//! 隧道状态的唯一真值来源:内存态 + `tunnel_settings` 表持久化。
//!
//! ## 为什么端口和 token 不落库
//!
//! `StoredTunnelSpec` 只存「用户表达的意图」:目标、名字、过期时间、项目归属。
//! 端口和访问 token 是**本次进程**的运行态,重启后重新分配:
//!
//! - 端口:上次那个端口这次可能已被别的进程占用,存下来只会在启动时失败
//! - token:进程重启后旧链接理应失效,这是想要的语义而不是缺陷
//!
//! 换句话说,落库的是「用户想暴露 5173」,不是「上次暴露在 19273 上」。
//! 这样重启后隧道自动重建,链接会变——与旧架构 slug 由 Gateway 重新分配一致。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::commands::settings::open_db;
use crate::events::EventBus;
use crate::runtime::project_path::project_path_key as normalize_project_path_key;

use super::{
    validate_tunnel_target_url, TunnelBinding, TunnelCreateInput, TunnelDataPlane, TunnelError,
    TunnelHealth, TunnelState, TunnelStatus, TunnelUpdateInput, DEFAULT_TTL_SECONDS, MAX_TUNNELS,
    TTL_WHITELIST, TUNNEL_STATE_EVENT,
};

const TUNNEL_SETTINGS_TABLE: &str = "tunnel_settings";

/// 两次自动探活之间的最小间隔。显式 check 绕过它。
const PROBE_THROTTLE: Duration = Duration::from_secs(15);

/// 访问 token 的字节数。32 字节 base64url ≈ 43 字符,穷举不可行。
const ACCESS_TOKEN_BYTES: usize = 32;

/// 落库的隧道规格。只有用户意图,没有运行态(见模块文档)。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredTunnelSpec {
    pub id: String,
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

/// 一条隧道的运行态:监听端口 + 访问 token。进程级,不落库。
#[derive(Debug, Clone)]
struct TunnelRuntime {
    port: u16,
    access_token: String,
}

#[derive(Default)]
struct State {
    specs: HashMap<String, StoredTunnelSpec>,
    runtimes: HashMap<String, TunnelRuntime>,
    health: HashMap<String, TunnelHealth>,
    probed_at: HashMap<String, Instant>,
    /// 每次发布事件自增。前端靠它挡住乱序到达的旧快照。
    emit_seq: u64,
}

/// 隧道状态存储。所有变更都经由它,并在变更后发 `tunnel:state`。
pub struct TunnelStore {
    events: Arc<EventBus>,
    data_plane: Arc<dyn TunnelDataPlane>,
    state: Mutex<State>,
}

impl TunnelStore {
    pub fn new(events: Arc<EventBus>, data_plane: Arc<dyn TunnelDataPlane>) -> Self {
        Self {
            events,
            data_plane,
            state: Mutex::new(State::default()),
        }
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, State>, String> {
        self.state
            .lock()
            .map_err(|_| "tunnel store lock poisoned".to_string())
    }

    /// 从库里装载规格,丢弃已过期的,给存活的起监听。
    ///
    /// 起不来的(端口占满、目标非法)会被剔除并持久化删除——留一条起不来的隧道
    /// 在列表里只会让用户以为它能用。
    pub async fn initialize(&self) -> Result<(), String> {
        let specs = load_specs().await?;
        let now = now_unix_seconds();
        let live: Vec<StoredTunnelSpec> = {
            let mut state = self.lock()?;
            for spec in specs {
                if spec_expired(&spec, now) {
                    continue;
                }
                state.specs.entry(spec.id.clone()).or_insert(spec);
            }
            state.specs.values().cloned().collect()
        };

        let mut dropped = Vec::new();
        for spec in live {
            let access_token = generate_access_token();
            let binding = TunnelBinding {
                id: spec.id.clone(),
                target_url: spec.target_url.clone(),
                access_token: access_token.clone(),
            };
            match self.data_plane.start(binding) {
                Ok(port) => {
                    self.lock()?
                        .runtimes
                        .insert(spec.id.clone(), TunnelRuntime { port, access_token });
                }
                Err(error) => {
                    eprintln!("隧道 {} 启动失败，已丢弃：{error}", spec.id);
                    let mut state = self.lock()?;
                    remove_tunnel(&mut state, &spec.id);
                    dropped.push(spec.id);
                }
            }
        }
        // 库里也删掉，否则下次启动还会再试一次同样失败的启动。
        if !dropped.is_empty() {
            delete_specs(dropped).await?;
        }
        self.publish()
    }

    /// 当前快照。前端首次拉取用。
    pub fn state(&self) -> Result<TunnelState, String> {
        let mut state = self.lock()?;
        Ok(build_state(&mut state, now_unix_seconds()))
    }

    /// 建隧道。
    pub async fn create(&self, input: TunnelCreateInput) -> Result<String, TunnelError> {
        let now = now_unix_seconds();
        let spec = {
            let mut state = self.lock().map_err(TunnelError::internal)?;
            sweep_expired(&mut state, now);
            prepare_create(&state, input, now)?
        };

        let access_token = generate_access_token();
        let port = self
            .data_plane
            .start(TunnelBinding {
                id: spec.id.clone(),
                target_url: spec.target_url.clone(),
                access_token: access_token.clone(),
            })
            .map_err(|error| TunnelError::new("port_unavailable", error))?;

        // 落库失败要停掉刚起的监听，否则会留下一个列表里看不见、
        // 端口却占着的幽灵隧道。
        if let Err(error) = persist_spec(spec.clone()).await {
            self.data_plane.stop(&spec.id);
            return Err(TunnelError::internal(error));
        }
        {
            let mut state = self.lock().map_err(TunnelError::internal)?;
            state
                .runtimes
                .insert(spec.id.clone(), TunnelRuntime { port, access_token });
            state.specs.insert(spec.id.clone(), spec.clone());
        }
        self.publish().map_err(TunnelError::internal)?;
        Ok(spec.id)
    }

    /// 改隧道。目标变了要重建监听,所以重新 start(数据面负责先停旧的)。
    pub async fn update(&self, input: TunnelUpdateInput) -> Result<String, TunnelError> {
        let (spec, previous_token) = {
            let state = self.lock().map_err(TunnelError::internal)?;
            let spec = prepare_update(&state, input)?;
            let token = state
                .runtimes
                .get(&spec.id)
                .map(|runtime| runtime.access_token.clone())
                .ok_or_else(TunnelError::not_found)?;
            (spec, token)
        };

        // token 保持不变：用户可能已经把链接发出去了，改个目标不该让它失效。
        let port = self
            .data_plane
            .start(TunnelBinding {
                id: spec.id.clone(),
                target_url: spec.target_url.clone(),
                access_token: previous_token.clone(),
            })
            .map_err(|error| TunnelError::new("port_unavailable", error))?;

        if let Err(error) = persist_spec(spec.clone()).await {
            self.data_plane.stop(&spec.id);
            let mut state = self.lock().map_err(TunnelError::internal)?;
            remove_tunnel(&mut state, &spec.id);
            return Err(TunnelError::internal(error));
        }
        {
            let mut state = self.lock().map_err(TunnelError::internal)?;
            state.runtimes.insert(
                spec.id.clone(),
                TunnelRuntime {
                    port,
                    access_token: previous_token,
                },
            );
            state.specs.insert(spec.id.clone(), spec.clone());
        }
        self.publish().map_err(TunnelError::internal)?;
        Ok(spec.id)
    }

    /// 关隧道。
    pub async fn close(&self, tunnel_id: String) -> Result<String, TunnelError> {
        let tunnel_id = tunnel_id.trim().to_string();
        if tunnel_id.is_empty() {
            return Err(TunnelError::not_found());
        }
        {
            let state = self.lock().map_err(TunnelError::internal)?;
            if !state.specs.contains_key(&tunnel_id) {
                return Err(TunnelError::not_found());
            }
        }
        delete_specs(vec![tunnel_id.clone()])
            .await
            .map_err(TunnelError::internal)?;
        self.data_plane.stop(&tunnel_id);
        {
            let mut state = self.lock().map_err(TunnelError::internal)?;
            remove_tunnel(&mut state, &tunnel_id);
        }
        self.publish().map_err(TunnelError::internal)?;
        Ok(tunnel_id)
    }

    /// 认领待探活的目标,并盖上节流时间戳。
    ///
    /// 返回 `(id, target_url)`。`bypass_throttle` 供显式 check 使用。
    pub fn claim_probe_targets(
        &self,
        tunnel_ids: Option<Vec<String>>,
        bypass_throttle: bool,
    ) -> Result<Vec<(String, String)>, String> {
        let mut state = self.lock()?;
        let now_unix = now_unix_seconds();
        let now = Instant::now();
        let candidates: Vec<String> = match tunnel_ids {
            Some(ids) => ids
                .into_iter()
                .map(|id| id.trim().to_string())
                .filter(|id| !id.is_empty())
                .collect(),
            None => state.specs.keys().cloned().collect(),
        };
        let mut targets = Vec::new();
        for id in candidates {
            let Some(spec) = state.specs.get(&id) else {
                continue;
            };
            if spec_expired(spec, now_unix) {
                continue;
            }
            if !bypass_throttle {
                let throttled = state
                    .probed_at
                    .get(&id)
                    .map(|at| now.duration_since(*at) < PROBE_THROTTLE)
                    .unwrap_or(false);
                if throttled {
                    continue;
                }
            }
            let target_url = spec.target_url.clone();
            state.probed_at.insert(id.clone(), now);
            targets.push((id, target_url));
        }
        Ok(targets)
    }

    /// 记录探活结果并广播。
    pub fn record_health(&self, results: &[(String, TunnelHealth)]) -> Result<(), String> {
        {
            let mut state = self.lock()?;
            for (id, health) in results {
                state.health.insert(id.clone(), health.clone());
            }
        }
        self.publish()
    }

    /// 检查某条隧道是否存在。`check` 命令用它区分 not_found 与「探测全部」。
    pub fn exists(&self, tunnel_id: &str) -> Result<bool, String> {
        Ok(self.lock()?.specs.contains_key(tunnel_id.trim()))
    }

    /// 清掉已过期的隧道,顺便停掉它们的监听。
    pub async fn sweep(&self) -> Result<Vec<String>, String> {
        let expired = {
            let mut state = self.lock()?;
            sweep_expired(&mut state, now_unix_seconds())
        };
        if expired.is_empty() {
            return Ok(expired);
        }
        for id in &expired {
            self.data_plane.stop(id);
        }
        delete_specs(expired.clone()).await?;
        self.publish()?;
        Ok(expired)
    }

    /// 发布当前快照。所有变更路径的唯一出口。
    fn publish(&self) -> Result<(), String> {
        let payload = {
            let mut state = self.lock()?;
            build_state(&mut state, now_unix_seconds())
        };
        self.events.emit(TUNNEL_STATE_EVENT, payload);
        Ok(())
    }
}

/// 组装快照并盖上单调递增的 revision。
///
/// revision 在**同一把锁内**自增,所以并发变更产生的快照不会拿到相同或倒退的
/// 序号——前端的单调性守卫依赖这一点。
fn build_state(state: &mut State, now: i64) -> TunnelState {
    state.emit_seq += 1;
    let revision = state.emit_seq;
    let mut specs: Vec<StoredTunnelSpec> = state
        .specs
        .values()
        .filter(|spec| !spec_expired(spec, now))
        .cloned()
        .collect();
    specs.sort_by(|a, b| a.created_at.cmp(&b.created_at).then_with(|| a.id.cmp(&b.id)));
    let tunnels = specs
        .into_iter()
        .map(|spec| {
            let runtime = state.runtimes.get(&spec.id);
            TunnelStatus {
                public_url: runtime
                    .map(|r| public_url(r.port, &r.access_token))
                    .unwrap_or_default(),
                port: runtime.map(|r| r.port).unwrap_or(0),
                local: state.health.get(&spec.id).cloned(),
                id: spec.id,
                slug: String::new(),
                name: spec.name,
                target_url: spec.target_url,
                public_path: "/".to_string(),
                created_at: spec.created_at,
                expires_at: spec.expires_at,
                active_connections: 0,
                project_path_key: spec.project_path_key,
            }
        })
        .collect();
    TunnelState {
        revision,
        agent_online: true,
        relay: None,
        tunnels,
    }
}

/// 隧道的完整访问地址。host 用 `127.0.0.1`——后端不知道自己被从哪个地址访问,
/// 猜一个只会给出错的链接。远程访问时用户把 host 换成自己的即可。
fn public_url(port: u16, access_token: &str) -> String {
    format!("http://127.0.0.1:{port}/?t={access_token}")
}

fn remove_tunnel(state: &mut State, tunnel_id: &str) {
    state.specs.remove(tunnel_id);
    state.runtimes.remove(tunnel_id);
    state.health.remove(tunnel_id);
    state.probed_at.remove(tunnel_id);
}

fn spec_expired(spec: &StoredTunnelSpec, now: i64) -> bool {
    spec.expires_at > 0 && spec.expires_at <= now
}

fn sweep_expired(state: &mut State, now: i64) -> Vec<String> {
    let expired: Vec<String> = state
        .specs
        .values()
        .filter(|spec| spec_expired(spec, now))
        .map(|spec| spec.id.clone())
        .collect();
    for id in &expired {
        remove_tunnel(state, id);
    }
    expired
}

fn prepare_create(
    state: &State,
    input: TunnelCreateInput,
    now: i64,
) -> Result<StoredTunnelSpec, TunnelError> {
    let target = validate_tunnel_target_url(&input.target_url)
        .map_err(|error| TunnelError::new("invalid_target", error))?;
    let ttl_seconds = normalize_ttl(input.ttl_seconds)
        .map_err(|error| TunnelError::new("invalid_ttl", error))?;
    let active = state
        .specs
        .values()
        .filter(|spec| !spec_expired(spec, now))
        .count();
    if active >= MAX_TUNNELS {
        return Err(TunnelError::new(
            "limit_exceeded",
            format!("at most {MAX_TUNNELS} tunnels are allowed"),
        ));
    }
    Ok(StoredTunnelSpec {
        id: generate_tunnel_id(),
        name: input.name.unwrap_or_default().trim().to_string(),
        target_url: target.url.to_string(),
        expires_at: expires_at(ttl_seconds, now),
        project_path_key: normalize_project_path_key(&input.project_path_key.unwrap_or_default()),
        created_at: now,
    })
}

fn prepare_update(state: &State, input: TunnelUpdateInput) -> Result<StoredTunnelSpec, TunnelError> {
    let tunnel_id = input.id.trim().to_string();
    if tunnel_id.is_empty() {
        return Err(TunnelError::not_found());
    }
    let existing = state
        .specs
        .get(&tunnel_id)
        .ok_or_else(TunnelError::not_found)?;
    let target = validate_tunnel_target_url(&input.target_url)
        .map_err(|error| TunnelError::new("invalid_target", error))?;
    // ttlSeconds 缺省保持当前过期时间；给了就从现在重新计算。
    let expires = match input.ttl_seconds {
        None => existing.expires_at,
        Some(ttl_seconds) => {
            let ttl_seconds = normalize_ttl(Some(ttl_seconds))
                .map_err(|error| TunnelError::new("invalid_ttl", error))?;
            expires_at(ttl_seconds, now_unix_seconds())
        }
    };
    Ok(StoredTunnelSpec {
        id: existing.id.clone(),
        name: input.name.unwrap_or_default().trim().to_string(),
        target_url: target.url.to_string(),
        expires_at: expires,
        project_path_key: normalize_project_path_key(&input.project_path_key.unwrap_or_default()),
        created_at: existing.created_at,
    })
}

fn normalize_ttl(input: Option<u32>) -> Result<u32, String> {
    let ttl_seconds = input.unwrap_or(DEFAULT_TTL_SECONDS);
    if TTL_WHITELIST.contains(&ttl_seconds) {
        Ok(ttl_seconds)
    } else {
        Err("ttlSeconds must be one of 0, 900, 3600, or 14400".to_string())
    }
}

fn expires_at(ttl_seconds: u32, now: i64) -> i64 {
    if ttl_seconds == 0 {
        return 0;
    }
    now + i64::from(ttl_seconds)
}

fn generate_tunnel_id() -> String {
    format!("tun_{}", Uuid::new_v4().simple())
}

fn generate_access_token() -> String {
    // 两个 v4 UUID = 32 字节随机数据，来源与 rand 相同（getrandom）。
    let mut bytes = Vec::with_capacity(ACCESS_TOKEN_BYTES);
    while bytes.len() < ACCESS_TOKEN_BYTES {
        bytes.extend_from_slice(Uuid::new_v4().as_bytes());
    }
    bytes.truncate(ACCESS_TOKEN_BYTES);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&bytes)
}

pub fn now_unix_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| Duration::from_secs(0))
        .as_millis() as i64
}

async fn load_specs() -> Result<Vec<StoredTunnelSpec>, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_db()?;
        load_specs_sync(&conn)
    })
    .await
    .map_err(|e| format!("load tunnel specs join failed: {e}"))?
}

async fn persist_spec(spec: StoredTunnelSpec) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_db()?;
        persist_spec_sync(&conn, &spec)
    })
    .await
    .map_err(|e| format!("persist tunnel spec join failed: {e}"))?
}

async fn delete_specs(tunnel_ids: Vec<String>) -> Result<(), String> {
    if tunnel_ids.is_empty() {
        return Ok(());
    }
    tokio::task::spawn_blocking(move || {
        let conn = open_db()?;
        for tunnel_id in &tunnel_ids {
            delete_spec_sync(&conn, tunnel_id)?;
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("delete tunnel specs join failed: {e}"))?
}

fn load_specs_sync(conn: &Connection) -> Result<Vec<StoredTunnelSpec>, String> {
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
            // 一条坏记录不该让整个隧道功能起不来。
            Err(error) => eprintln!("parse tunnel spec {tunnel_id} failed: {error}"),
        }
    }
    Ok(specs)
}

fn persist_spec_sync(conn: &Connection, spec: &StoredTunnelSpec) -> Result<(), String> {
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

fn delete_spec_sync(conn: &Connection, tunnel_id: &str) -> Result<(), String> {
    conn.execute(
        &format!("DELETE FROM {TUNNEL_SETTINGS_TABLE} WHERE tunnel_id = ?1"),
        params![tunnel_id],
    )
    .map_err(|e| format!("delete from {TUNNEL_SETTINGS_TABLE} failed: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_input(target_url: &str) -> TunnelCreateInput {
        TunnelCreateInput {
            target_url: target_url.to_string(),
            name: Some(" dev server ".to_string()),
            ttl_seconds: None,
            project_path_key: Some("/workspace/project".to_string()),
        }
    }

    fn insert(state: &mut State, spec: StoredTunnelSpec) {
        state.runtimes.insert(
            spec.id.clone(),
            TunnelRuntime {
                port: 19273,
                access_token: "test-token".to_string(),
            },
        );
        state.specs.insert(spec.id.clone(), spec);
    }

    #[test]
    fn create_applies_defaults_and_validation() {
        let state = State::default();
        let now = 1_000;

        let spec = prepare_create(&state, create_input("http://localhost:3000"), now).unwrap();
        assert_eq!(spec.name, "dev server");
        assert_eq!(spec.target_url, "http://localhost:3000/");
        assert_eq!(spec.created_at, now);
        assert_eq!(spec.expires_at, now + i64::from(DEFAULT_TTL_SECONDS));

        assert_eq!(
            prepare_create(&state, create_input("http://example.com"), now)
                .unwrap_err()
                .code,
            "invalid_target"
        );

        let mut bad_ttl = create_input("http://localhost:3000");
        bad_ttl.ttl_seconds = Some(123);
        assert_eq!(
            prepare_create(&state, bad_ttl, now).unwrap_err().code,
            "invalid_ttl"
        );
    }

    #[test]
    fn create_enforces_tunnel_limit_and_ignores_expired() {
        let mut state = State::default();
        let now = 1_000;
        for _ in 0..MAX_TUNNELS {
            let spec = prepare_create(&state, create_input("http://localhost:3000"), now).unwrap();
            insert(&mut state, spec);
        }
        assert_eq!(
            prepare_create(&state, create_input("http://localhost:3000"), now)
                .unwrap_err()
                .code,
            "limit_exceeded"
        );

        // 过期的不再占额度。
        state.specs.values_mut().next().unwrap().expires_at = now - 1;
        assert!(prepare_create(&state, create_input("http://localhost:3000"), now).is_ok());
    }

    #[test]
    fn update_keeps_expiry_when_ttl_absent_and_recomputes_when_given() {
        let mut state = State::default();
        let now = 1_000;
        let mut spec = prepare_create(&state, create_input("http://localhost:3000"), now).unwrap();
        spec.expires_at = 4_242;
        let id = spec.id.clone();
        insert(&mut state, spec);

        let kept = prepare_update(
            &state,
            TunnelUpdateInput {
                id: id.clone(),
                target_url: "http://127.0.0.1:8080".to_string(),
                name: Some("renamed".to_string()),
                ttl_seconds: None,
                project_path_key: None,
            },
        )
        .unwrap();
        assert_eq!(kept.expires_at, 4_242, "ttlSeconds 缺省必须保持原过期时间");
        assert_eq!(kept.name, "renamed");
        assert_eq!(kept.target_url, "http://127.0.0.1:8080/");
        assert_eq!(kept.created_at, now, "created_at 不该被更新覆盖");

        let recomputed = prepare_update(
            &state,
            TunnelUpdateInput {
                id: id.clone(),
                target_url: "http://127.0.0.1:8080".to_string(),
                name: None,
                ttl_seconds: Some(900),
                project_path_key: None,
            },
        )
        .unwrap();
        assert_ne!(recomputed.expires_at, 4_242);

        assert_eq!(
            prepare_update(
                &state,
                TunnelUpdateInput {
                    id: "tun_missing".to_string(),
                    target_url: "http://127.0.0.1:8080".to_string(),
                    name: None,
                    ttl_seconds: None,
                    project_path_key: None,
                },
            )
            .unwrap_err()
            .code,
            "not_found"
        );
    }

    #[test]
    fn ttl_whitelist_allows_infinite_and_rejects_others() {
        assert_eq!(normalize_ttl(Some(0)).unwrap(), 0);
        assert_eq!(expires_at(0, 1_000), 0, "0 表示永不过期");
        assert!(normalize_ttl(Some(1)).is_err());
        assert_eq!(normalize_ttl(None).unwrap(), DEFAULT_TTL_SECONDS);
    }

    #[test]
    fn state_revision_is_strictly_monotonic() {
        let mut state = State::default();
        let first = build_state(&mut state, 1_000).revision;
        let second = build_state(&mut state, 1_000).revision;
        let third = build_state(&mut state, 1_000).revision;
        assert_eq!((first, second, third), (1, 2, 3));
    }

    #[test]
    fn state_hides_expired_tunnels_and_exposes_public_url() {
        let mut state = State::default();
        let now = 1_000;

        let live = prepare_create(&state, create_input("http://localhost:3000"), now).unwrap();
        let live_id = live.id.clone();
        insert(&mut state, live);

        let mut expired =
            prepare_create(&state, create_input("http://localhost:4000"), now).unwrap();
        expired.expires_at = now - 1;
        insert(&mut state, expired);

        let snapshot = build_state(&mut state, now);
        assert_eq!(snapshot.tunnels.len(), 1, "过期隧道不该出现在快照里");
        let tunnel = &snapshot.tunnels[0];
        assert_eq!(tunnel.id, live_id);
        assert_eq!(tunnel.port, 19273);
        assert_eq!(tunnel.public_url, "http://127.0.0.1:19273/?t=test-token");
        assert_eq!(tunnel.public_path, "/", "路径 1:1，不挂子路径");
        assert!(tunnel.slug.is_empty(), "新架构没有 slug");
        assert!(snapshot.agent_online, "后端自己在跑，不存在离线");
        assert!(snapshot.relay.is_none(), "没有中继");
    }

    #[test]
    fn sweep_removes_expired_and_all_their_runtime_state() {
        let mut state = State::default();
        let now = 1_000;
        let mut spec = prepare_create(&state, create_input("http://localhost:3000"), now).unwrap();
        spec.expires_at = now - 1;
        let id = spec.id.clone();
        insert(&mut state, spec);
        state
            .health
            .insert(id.clone(), TunnelHealth::failed("boom".to_string(), now));
        state.probed_at.insert(id.clone(), Instant::now());

        let expired = sweep_expired(&mut state, now);
        assert_eq!(expired, vec![id.clone()]);
        // 端口/健康/节流全部一起清掉，否则重用 id 会读到上一条的残留。
        assert!(!state.specs.contains_key(&id));
        assert!(!state.runtimes.contains_key(&id));
        assert!(!state.health.contains_key(&id));
        assert!(!state.probed_at.contains_key(&id));
    }

    #[test]
    fn allocated_tokens_are_unique_and_url_safe() {
        let a = generate_access_token();
        let b = generate_access_token();
        assert_ne!(a, b);
        // 43 字符 = 32 字节 base64url 无填充。
        assert_eq!(a.len(), 43);
        assert!(
            a.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'),
            "token 要能直接放进 URL query：{a}"
        );
    }

    #[test]
    fn generated_ids_are_prefixed_and_unique() {
        let first = generate_tunnel_id();
        assert!(first.starts_with("tun_"), "{first}");
        assert_ne!(first, generate_tunnel_id());
    }
}
