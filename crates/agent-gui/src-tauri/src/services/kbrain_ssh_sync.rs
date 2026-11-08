//! Pushes the desktop's SSH hosts and project associations to K-brain's SSHManager
//! (`/v1/settings/ssh`, capability `ssh_manager`).
//!
//! Source of truth: Settings > SSH in LiveAgent's settings database is where hosts,
//! secrets and project associations are edited; K-brain keeps the runtime copy its
//! SSHManager tool connects with. The desktop pushes the complete list on every SSH
//! settings change and whenever a K-brain backend (re)connects, so hosts edited or
//! deleted elsewhere in K-brain are overwritten by the desktop's list.
//!
//! Host keys are the exception: K-brain owns its own known_hosts for agent
//! connections ("Trust and save" on its host-key question). The desktop only reads
//! them (`settings_kbrain_ssh_state`) and forgets them through
//! `DELETE /v1/settings/ssh/hosts/{id}/host-keys`. The desktop's SSH terminal tabs keep
//! their separate `ssh_known_hosts` table.
//!
//! Secrets are write-only in K-brain. A secret is sent only when K-brain does not
//! have one, the host is new or changed auth type (K-brain then drops stored
//! secrets), or the value changed since the last successful push. "Changed" is
//! decided with salted SHA-256 digests in `kbrain_ssh_secret_digests`, keyed by the
//! K-brain storage id. Secret values never appear in errors or logs.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use reqwest::blocking::Client;
use reqwest::header::AUTHORIZATION;
use reqwest::StatusCode;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::runtime::project_path::project_path_key;
use crate::services::kbrain_backend::{KBrainBackendConnection, KBrainBackendState};

const SSH_SETTINGS_PATH: &str = "/v1/settings/ssh";
const CAPABILITY: &str = "ssh_manager";
const MAX_HOSTS: usize = 256;
const MAX_HOSTS_PER_PROJECT: usize = 64;
const MAX_HOST_ID_BYTES: usize = 128;
const MAX_ERROR_CHARS: usize = 300;

const FIELD_PASSWORD: &str = "password";
const FIELD_PRIVATE_KEY: &str = "privateKey";
const FIELD_PASSPHRASE: &str = "privateKeyPassphrase";
const FIELD_PROXY_PASSWORD: &str = "proxy.password";

static BACKEND: OnceLock<Arc<KBrainBackendState>> = OnceLock::new();
/// One sync at a time: each re-reads the database, so a queued one sees the newest list.
static SYNC_LOCK: Mutex<()> = Mutex::new(());

/// Result of one sync against a running K-brain.
#[derive(Debug, Default)]
pub(crate) struct SyncOutcome {
    /// False for a K-brain without `ssh_manager`: nothing was sent.
    pub supported: bool,
    /// Whether a PUT was needed (false when K-brain already matched).
    pub pushed: bool,
    /// K-brain's public SSH document after the sync (no secrets).
    pub document: Option<Value>,
    /// Desktop hosts K-brain would reject (bad id, name, host or port); not sent.
    pub skipped: Vec<String>,
}

/// Starts following K-brain: every (re)connect pushes the desktop's SSH settings.
pub(crate) fn install(state: Arc<KBrainBackendState>) {
    if BACKEND.set(Arc::clone(&state)).is_err() {
        return;
    }
    let mut changes = state.subscribe_connection();
    tauri::async_runtime::spawn(async move {
        loop {
            let connection = changes.borrow_and_update().clone();
            if let Some(connection) = connection {
                let result =
                    tauri::async_runtime::spawn_blocking(move || sync_running(&connection)).await;
                if let Ok(Err(error)) = result {
                    eprintln!("K-brain SSH settings sync failed: {error}");
                }
            }
            if changes.changed().await.is_err() {
                return;
            }
        }
    });
}

/// Pushes the SSH settings to the running K-brain in the background (best effort).
/// A no-op before `install` (tests) or while no K-brain runs; never starts one.
pub(crate) fn request_sync() {
    let Some(connection) = running_connection() else {
        return;
    };
    std::thread::spawn(move || {
        if let Err(error) = sync_running(&connection) {
            eprintln!("K-brain SSH settings sync failed: {error}");
        }
    });
}

pub(crate) fn running_connection() -> Option<KBrainBackendConnection> {
    BACKEND.get()?.running_connection()
}

/// Syncs now, against the given backend, and returns K-brain's document.
pub(crate) fn sync_running(connection: &KBrainBackendConnection) -> Result<SyncOutcome, String> {
    let _guard = SYNC_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let db = crate::commands::settings::open_db()?;
    let desktop = crate::commands::settings::load_ssh_settings_for_kbrain(&db)?;
    let client = client()?;
    sync_with(&client, connection, &db, &desktop)
}

/// Forgets the K-brain host keys of every desktop host at host:port. Returns how many
/// keys K-brain removed; 0 when K-brain is not running or lacks SSHManager.
pub(crate) fn forget_host_keys(host: &str, port: u16) -> Result<usize, String> {
    let Some(connection) = running_connection() else {
        return Ok(0);
    };
    let outcome = sync_running(&connection)?;
    if !outcome.supported {
        return Ok(0);
    }
    let host = host.trim();
    let ids: Vec<String> = outcome
        .document
        .as_ref()
        .and_then(|doc| doc.get("hosts"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|item| {
            item.get("host").and_then(Value::as_str).map(str::trim) == Some(host)
                && item.get("port").and_then(Value::as_u64) == Some(u64::from(port))
        })
        .filter_map(|item| item.get("id").and_then(Value::as_str).map(str::to_string))
        .collect();
    let client = client()?;
    let mut removed = 0;
    for id in ids {
        removed += delete_host_keys(&client, &connection, &id)?;
    }
    Ok(removed)
}

fn client() -> Result<Client, String> {
    Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|error| format!("failed to create K-brain client: {error}"))
}

fn sync_with(
    client: &Client,
    connection: &KBrainBackendConnection,
    db: &Connection,
    desktop: &Value,
) -> Result<SyncOutcome, String> {
    if !supports_ssh_manager(&get_json(client, connection, "/v1/health")?) {
        return Ok(SyncOutcome::default());
    }
    let digests = DigestStore::open(db, &connection.storage_id)?;
    let mut last_conflict = String::new();
    for _attempt in 0..2 {
        let remote = get_json(client, connection, SSH_SETTINGS_PATH)?;
        let plan = plan_push(desktop, &remote, &digests);
        let Some(body) = plan.body else {
            return Ok(SyncOutcome {
                supported: true,
                pushed: false,
                document: Some(remote),
                skipped: plan.skipped,
            });
        };
        match put_json(client, connection, SSH_SETTINGS_PATH, &body)? {
            PutResult::Ok(document) => {
                digests.record(&plan.secrets)?;
                return Ok(SyncOutcome {
                    supported: true,
                    pushed: true,
                    document: Some(document),
                    skipped: plan.skipped,
                });
            }
            // Someone else changed K-brain's SSH settings between GET and PUT:
            // re-read and rebuild once.
            PutResult::Conflict(message) => last_conflict = message,
        }
    }
    Err(format!(
        "K-brain SSH settings changed during the sync twice: {last_conflict}"
    ))
}

pub(crate) fn supports_ssh_manager(health: &Value) -> bool {
    health
        .get("capabilities")
        .and_then(|caps| caps.get(CAPABILITY))
        .and_then(Value::as_f64)
        .is_some_and(|version| version >= 1.0)
}

fn get_json(
    client: &Client,
    connection: &KBrainBackendConnection,
    path: &str,
) -> Result<Value, String> {
    let response = client
        .get(format!("{}{path}", connection.base_url))
        .header(AUTHORIZATION, format!("Bearer {}", connection.token))
        .send()
        .map_err(|error| format!("GET {path} failed: {}", error.without_url()))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "GET {path} returned {status}: {}",
            error_text(response)
        ));
    }
    response
        .json::<Value>()
        .map_err(|error| format!("GET {path} returned invalid JSON: {}", error.without_url()))
}

enum PutResult {
    Ok(Value),
    Conflict(String),
}

fn put_json(
    client: &Client,
    connection: &KBrainBackendConnection,
    path: &str,
    body: &Value,
) -> Result<PutResult, String> {
    // The body may carry secrets: errors never include it, only K-brain's message,
    // which names fields but not values.
    let response = client
        .put(format!("{}{path}", connection.base_url))
        .header(AUTHORIZATION, format!("Bearer {}", connection.token))
        .json(body)
        .send()
        .map_err(|error| format!("PUT {path} failed: {}", error.without_url()))?;
    let status = response.status();
    if status == StatusCode::CONFLICT {
        return Ok(PutResult::Conflict(error_text(response)));
    }
    if !status.is_success() {
        return Err(format!(
            "PUT {path} returned {status}: {}",
            error_text(response)
        ));
    }
    response
        .json::<Value>()
        .map(PutResult::Ok)
        .map_err(|error| format!("PUT {path} returned invalid JSON: {}", error.without_url()))
}

fn delete_host_keys(
    client: &Client,
    connection: &KBrainBackendConnection,
    host_id: &str,
) -> Result<usize, String> {
    let path = format!(
        "{SSH_SETTINGS_PATH}/hosts/{}/host-keys",
        percent_encode_segment(host_id)
    );
    let response = client
        .delete(format!("{}{path}", connection.base_url))
        .header(AUTHORIZATION, format!("Bearer {}", connection.token))
        .send()
        .map_err(|error| format!("forget K-brain host keys failed: {}", error.without_url()))?;
    let status = response.status();
    if status == StatusCode::NOT_FOUND {
        return Ok(0);
    }
    if !status.is_success() {
        return Err(format!(
            "forget K-brain host keys returned {status}: {}",
            error_text(response)
        ));
    }
    let body = response.json::<Value>().unwrap_or(Value::Null);
    Ok(body.get("removed").and_then(Value::as_u64).unwrap_or(0) as usize)
}

fn percent_encode_segment(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn error_text(response: reqwest::blocking::Response) -> String {
    let text = response.text().unwrap_or_default();
    let message = serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|body| {
            body.get("error")
                .and_then(|error| {
                    error.as_str().map(str::to_string).or_else(|| {
                        error
                            .get("message")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                    })
                })
                .or_else(|| {
                    body.get("message")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
        })
        .unwrap_or(text);
    message.trim().chars().take(MAX_ERROR_CHARS).collect()
}

/// A secret the push leaves in K-brain: its digest is recorded after a successful
/// PUT; `None` means K-brain holds no value for it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct SecretState {
    host_id: String,
    field: &'static str,
    value: Option<String>,
}

#[derive(Debug, Default)]
struct PushPlan {
    /// The PUT body, or None when K-brain already matches the desktop.
    body: Option<Value>,
    secrets: Vec<SecretState>,
    skipped: Vec<String>,
}

trait SecretDigests {
    /// Whether `value` is what the last successful push sent for this secret.
    fn matches(&self, host_id: &str, field: &str, value: &str) -> bool;
    /// Whether the last successful push left a value for this secret.
    fn recorded(&self, host_id: &str, field: &str) -> bool;
}

fn text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string()
}

/// Secrets are never trimmed: they are sent exactly as stored.
fn secret(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn number(value: &Value, key: &str) -> i64 {
    match value.get(key) {
        Some(Value::Number(number)) => number.as_i64().unwrap_or(-1),
        Some(Value::String(text)) if text.trim().is_empty() => 0,
        Some(Value::String(text)) => text.trim().parse().unwrap_or(-1),
        _ => 0,
    }
}

fn flag(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

/// Mirrors K-brain's host validation for the fields the desktop does not enforce
/// itself, so one host it would refuse does not block the others.
fn kbrain_accepts(id: &str, name: &str, host: &str, port: i64) -> bool {
    !id.is_empty()
        && id.len() <= MAX_HOST_ID_BYTES
        && !id.contains(['/', '\\', '?', '#', '%'])
        && !name.is_empty()
        && !host.is_empty()
        && !host.contains([' ', '/', '@', '\t', '\r', '\n'])
        && (1..=65535).contains(&port)
}

/// The non-secret fields K-brain stores, normalized the way K-brain normalizes them,
/// so an unchanged host compares equal to K-brain's public copy.
fn comparable(host: &Value) -> Value {
    let auth_type = match text(host, "authType").as_str() {
        "" => "password".to_string(),
        other => other.to_string(),
    };
    let private_key_path = if auth_type == "privateKey" {
        text(host, "privateKeyPath")
    } else {
        String::new()
    };
    let proxy = host.get("proxy").cloned().unwrap_or(Value::Null);
    let proxy_type = match text(&proxy, "type").as_str() {
        "http" => "http",
        _ => "socks5",
    };
    let port = match number(host, "port") {
        0 => 22,
        port => port,
    };
    json!({
        "id": text(host, "id"),
        "name": text(host, "name"),
        "description": text(host, "description"),
        "host": text(host, "host"),
        "port": port,
        "username": text(host, "username"),
        "authType": auth_type,
        "privateKeyPath": private_key_path,
        "proxy": {
            "type": proxy_type,
            "url": text(&proxy, "url"),
            "port": number(&proxy, "port"),
            "username": text(&proxy, "username"),
            "useSystemProxy": flag(&proxy, "useSystemProxy"),
        },
    })
}

struct SecretField {
    field: &'static str,
    /// JSON key of the value; the clear flag is `clear` + capitalized key.
    key: &'static str,
    clear_key: &'static str,
    configured_key: &'static str,
}

const HOST_SECRETS: [SecretField; 3] = [
    SecretField {
        field: FIELD_PASSWORD,
        key: "password",
        clear_key: "clearPassword",
        configured_key: "passwordConfigured",
    },
    SecretField {
        field: FIELD_PRIVATE_KEY,
        key: "privateKey",
        clear_key: "clearPrivateKey",
        configured_key: "privateKeyConfigured",
    },
    SecretField {
        field: FIELD_PASSPHRASE,
        key: "privateKeyPassphrase",
        clear_key: "clearPrivateKeyPassphrase",
        configured_key: "privateKeyPassphraseConfigured",
    },
];

/// Which secrets K-brain keeps for an auth type (it drops the others on save).
fn secret_applies(auth_type: &str, field: &str) -> bool {
    match auth_type {
        "keyboardInteractive" => false,
        "privateKey" => field != FIELD_PASSWORD,
        _ => field == FIELD_PASSWORD,
    }
}

/// Decides one secret: writes the value or clear flag into `out` and reports whether
/// K-brain's copy differs from the desktop's.
#[allow(clippy::too_many_arguments)]
fn plan_secret(
    out: &mut Map<String, Value>,
    secrets: &mut Vec<SecretState>,
    digests: &dyn SecretDigests,
    host_id: &str,
    field: &'static str,
    key: &str,
    clear_key: &str,
    desktop_value: String,
    remote_configured: bool,
    must_resend: bool,
    ambiguous_configured: bool,
) -> bool {
    if !desktop_value.is_empty() {
        let send =
            must_resend || !remote_configured || !digests.matches(host_id, field, &desktop_value);
        if send {
            out.insert(key.to_string(), Value::String(desktop_value.clone()));
        }
        secrets.push(SecretState {
            host_id: host_id.to_string(),
            field,
            value: Some(desktop_value),
        });
        return send;
    }
    // An empty desktop value: clearing is harmless and never carries a secret.
    out.insert(clear_key.to_string(), Value::Bool(true));
    secrets.push(SecretState {
        host_id: host_id.to_string(),
        field,
        value: None,
    });
    if ambiguous_configured {
        // privateKeyConfigured is also true for a key path: only a key this desktop
        // pushed before is known to be stored inline.
        digests.recorded(host_id, field)
    } else {
        remote_configured
    }
}

fn plan_push(desktop: &Value, remote: &Value, digests: &dyn SecretDigests) -> PushPlan {
    let remote_hosts: Vec<&Value> = remote
        .get("hosts")
        .and_then(Value::as_array)
        .map(|hosts| hosts.iter().collect())
        .unwrap_or_default();
    let remote_by_id: HashMap<String, &Value> = remote_hosts
        .iter()
        .map(|host| (text(host, "id"), *host))
        .collect();

    let mut plan = PushPlan::default();
    let mut changed = false;
    let mut inputs = Vec::new();
    let mut desired_comparable = Vec::new();
    let mut sent_ids = HashSet::new();

    for host in desktop
        .get("hosts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let base = comparable(host);
        let id = text(&base, "id");
        if !kbrain_accepts(
            &id,
            &text(&base, "name"),
            &text(&base, "host"),
            number(&base, "port"),
        ) || sent_ids.contains(&id)
            || inputs.len() >= MAX_HOSTS
        {
            plan.skipped.push(id);
            continue;
        }
        sent_ids.insert(id.clone());
        let auth_type = text(&base, "authType");
        let remote_host = remote_by_id.get(&id).copied();
        let must_resend = remote_host.is_none_or(|remote| text(remote, "authType") != auth_type);

        let Value::Object(mut input) = base.clone() else {
            continue;
        };
        for field in &HOST_SECRETS {
            if !secret_applies(&auth_type, field.field) {
                continue;
            }
            let remote_configured = remote_host.is_some_and(|r| flag(r, field.configured_key));
            changed |= plan_secret(
                &mut input,
                &mut plan.secrets,
                digests,
                &id,
                field.field,
                field.key,
                field.clear_key,
                secret(host, field.key),
                remote_configured,
                must_resend,
                field.field == FIELD_PRIVATE_KEY && !text(&base, "privateKeyPath").is_empty(),
            );
        }
        let desktop_proxy = host.get("proxy").cloned().unwrap_or(Value::Null);
        let remote_proxy_configured = remote_host
            .and_then(|r| r.get("proxy"))
            .is_some_and(|proxy| flag(proxy, "passwordConfigured"));
        if let Some(Value::Object(proxy)) = input.get_mut("proxy") {
            changed |= plan_secret(
                proxy,
                &mut plan.secrets,
                digests,
                &id,
                FIELD_PROXY_PASSWORD,
                "password",
                "clearPassword",
                secret(&desktop_proxy, "password"),
                remote_proxy_configured,
                remote_host.is_none(),
                false,
            );
        }
        desired_comparable.push(base);
        inputs.push(Value::Object(input));
    }

    let remote_comparable: Vec<Value> = remote_hosts.iter().map(|host| comparable(host)).collect();
    changed |= desired_comparable != remote_comparable;

    let desired_associations = associations(desktop, &sent_ids);
    let remote_associations = associations(remote, &remote_by_id.keys().cloned().collect());
    changed |= desired_associations != remote_associations;

    if changed {
        let mut body = Map::new();
        if let Some(revision) = remote.get("revision").and_then(Value::as_u64) {
            if revision > 0 {
                body.insert("baseRevision".into(), json!(revision));
            }
        }
        body.insert("hosts".into(), Value::Array(inputs));
        body.insert(
            "projectHostAssociations".into(),
            serde_json::to_value(&desired_associations).unwrap_or_else(|_| json!({})),
        );
        plan.body = Some(Value::Object(body));
    }
    plan
}

/// Associations keyed like K-brain (`project_path_key`), limited to known hosts.
fn associations(document: &Value, known: &HashSet<String>) -> BTreeMap<String, Vec<String>> {
    let mut out = BTreeMap::new();
    let Some(map) = document
        .get("projectHostAssociations")
        .and_then(Value::as_object)
    else {
        return out;
    };
    let mut raw_keys: Vec<&String> = map.keys().collect();
    raw_keys.sort();
    let mut canonical = HashSet::new();
    for raw in raw_keys {
        let key = project_path_key(raw);
        if key.is_empty() {
            continue;
        }
        let mut seen = HashSet::new();
        let ids: Vec<String> = map[raw]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty() && known.contains(*id) && seen.insert(id.to_string()))
            .take(MAX_HOSTS_PER_PROJECT)
            .map(str::to_string)
            .collect();
        if ids.is_empty() {
            continue;
        }
        let is_canonical = raw.as_str() == key;
        if is_canonical || !canonical.contains(&key) {
            out.insert(key.clone(), ids);
        }
        if is_canonical {
            canonical.insert(key);
        }
    }
    out
}

/// Salted digests of the secrets last pushed to one K-brain storage.
struct DigestStore<'a> {
    db: &'a Connection,
    storage_id: String,
    salt: String,
    rows: HashMap<(String, String), String>,
}

impl<'a> DigestStore<'a> {
    fn open(db: &'a Connection, storage_id: &str) -> Result<Self, String> {
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS kbrain_ssh_secret_digests (
                storage_id TEXT NOT NULL,
                host_id TEXT NOT NULL,
                field TEXT NOT NULL,
                digest TEXT NOT NULL,
                PRIMARY KEY (storage_id, host_id, field)
            );",
        )
        .map_err(|e| format!("create kbrain_ssh_secret_digests failed: {e}"))?;
        // The salt row has an empty storage id, which no backend uses.
        let salt = db
            .query_row(
                "SELECT digest FROM kbrain_ssh_secret_digests WHERE storage_id = '' AND host_id = '' AND field = 'salt'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| format!("read kbrain_ssh_secret_digests failed: {e}"))?;
        let salt = match salt {
            Some(salt) => salt,
            None => {
                let mut bytes = [0_u8; 32];
                getrandom::fill(&mut bytes).map_err(|e| format!("random salt failed: {e}"))?;
                let salt: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
                db.execute(
                    "INSERT OR IGNORE INTO kbrain_ssh_secret_digests (storage_id, host_id, field, digest) VALUES ('', '', 'salt', ?1)",
                    params![salt],
                )
                .map_err(|e| format!("write kbrain_ssh_secret_digests failed: {e}"))?;
                db.query_row(
                    "SELECT digest FROM kbrain_ssh_secret_digests WHERE storage_id = '' AND host_id = '' AND field = 'salt'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .map_err(|e| format!("read kbrain_ssh_secret_digests failed: {e}"))?
            }
        };
        let mut rows = HashMap::new();
        let mut stmt = db
            .prepare("SELECT host_id, field, digest FROM kbrain_ssh_secret_digests WHERE storage_id = ?1")
            .map_err(|e| format!("read kbrain_ssh_secret_digests failed: {e}"))?;
        let found = stmt
            .query_map(params![storage_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| format!("read kbrain_ssh_secret_digests failed: {e}"))?;
        for row in found {
            let (host_id, field, digest) =
                row.map_err(|e| format!("read kbrain_ssh_secret_digests failed: {e}"))?;
            rows.insert((host_id, field), digest);
        }
        Ok(Self {
            db,
            storage_id: storage_id.to_string(),
            salt,
            rows,
        })
    }

    fn digest(&self, host_id: &str, field: &str, value: &str) -> String {
        let mut hasher = Sha256::new();
        for part in [
            self.salt.as_str(),
            self.storage_id.as_str(),
            host_id,
            field,
            value,
        ] {
            hasher.update((part.len() as u64).to_be_bytes());
            hasher.update(part.as_bytes());
        }
        hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }

    /// Replaces this storage's digests with what the successful push left in K-brain.
    fn record(&self, secrets: &[SecretState]) -> Result<(), String> {
        let tx = self
            .db
            .unchecked_transaction()
            .map_err(|e| format!("write kbrain_ssh_secret_digests failed: {e}"))?;
        tx.execute(
            "DELETE FROM kbrain_ssh_secret_digests WHERE storage_id = ?1",
            params![self.storage_id],
        )
        .map_err(|e| format!("write kbrain_ssh_secret_digests failed: {e}"))?;
        for secret in secrets {
            let Some(value) = &secret.value else {
                continue;
            };
            tx.execute(
                "INSERT OR REPLACE INTO kbrain_ssh_secret_digests (storage_id, host_id, field, digest) VALUES (?1, ?2, ?3, ?4)",
                params![
                    self.storage_id,
                    secret.host_id,
                    secret.field,
                    self.digest(&secret.host_id, secret.field, value)
                ],
            )
            .map_err(|e| format!("write kbrain_ssh_secret_digests failed: {e}"))?;
        }
        tx.commit()
            .map_err(|e| format!("write kbrain_ssh_secret_digests failed: {e}"))
    }
}

impl SecretDigests for DigestStore<'_> {
    fn matches(&self, host_id: &str, field: &str, value: &str) -> bool {
        self.rows
            .get(&(host_id.to_string(), field.to_string()))
            .is_some_and(|stored| *stored == self.digest(host_id, field, value))
    }

    fn recorded(&self, host_id: &str, field: &str) -> bool {
        self.rows
            .contains_key(&(host_id.to_string(), field.to_string()))
    }
}

/// K-brain's per-host state for Settings > SSH: credential and saved host keys.
pub(crate) fn public_state(outcome: Result<SyncOutcome, String>, connected: bool) -> Value {
    if !connected {
        return json!({ "connected": false, "supported": false });
    }
    match outcome {
        Ok(outcome) if !outcome.supported => json!({ "connected": true, "supported": false }),
        Ok(outcome) => {
            let document = outcome.document.unwrap_or(Value::Null);
            let hosts: Vec<Value> = document
                .get("hosts")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|host| {
                    json!({
                        "id": text(host, "id"),
                        "host": text(host, "host"),
                        "port": number(host, "port"),
                        "authType": text(host, "authType"),
                        "credential": text(host, "credential"),
                        "hostKeys": host.get("hostKeys").cloned().unwrap_or_else(|| json!([])),
                    })
                })
                .collect();
            json!({
                "connected": true,
                "supported": true,
                "hosts": hosts,
                "knownHostsPath": text(&document, "knownHostsPath"),
                "skippedHostIds": outcome.skipped,
                "pushed": outcome.pushed,
            })
        }
        Err(error) => json!({ "connected": true, "supported": true, "error": error }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::thread;

    struct NoDigests;
    impl SecretDigests for NoDigests {
        fn matches(&self, _: &str, _: &str, _: &str) -> bool {
            false
        }
        fn recorded(&self, _: &str, _: &str) -> bool {
            false
        }
    }

    fn desktop_host(id: &str, password: &str) -> Value {
        json!({
            "id": id, "name": "web", "description": "", "host": "127.0.0.1", "port": 2222,
            "username": "deploy", "authType": "password",
            "password": password, "passwordConfigured": !password.is_empty(),
            "privateKey": "", "privateKeyPath": "", "privateKeyConfigured": false,
            "privateKeyPassphrase": "", "privateKeyPassphraseConfigured": false,
            "proxy": { "type": "socks5", "url": "", "port": 0, "username": "", "password": "",
                       "passwordConfigured": false, "useSystemProxy": false },
        })
    }

    fn remote_host(id: &str, password_configured: bool) -> Value {
        json!({
            "id": id, "name": "web", "description": "", "host": "127.0.0.1", "port": 2222,
            "username": "deploy", "authType": "password",
            "password": "", "passwordConfigured": password_configured,
            "privateKey": "", "privateKeyPath": "", "privateKeyConfigured": false,
            "privateKeyPassphrase": "", "privateKeyPassphraseConfigured": false,
            "proxy": { "type": "socks5", "url": "", "port": 0, "username": "", "password": "",
                       "passwordConfigured": false, "useSystemProxy": false },
            "credential": if password_configured { "saved" } else { "missing" },
            "hostKeys": [],
        })
    }

    fn desktop(hosts: Vec<Value>, associations: Value) -> Value {
        json!({ "hosts": hosts, "projectHostAssociations": associations })
    }

    fn remote(revision: u64, hosts: Vec<Value>, associations: Value) -> Value {
        json!({ "revision": revision, "hosts": hosts, "projectHostAssociations": associations,
                "knownHostsPath": "/tmp/kb/ssh/known_hosts" })
    }

    fn memory_db() -> Connection {
        Connection::open_in_memory().expect("in-memory db")
    }

    #[test]
    fn capability_is_read_from_health() {
        assert!(supports_ssh_manager(
            &json!({"capabilities": {"ssh_manager": 1}})
        ));
        assert!(supports_ssh_manager(
            &json!({"capabilities": {"ssh_manager": 2}})
        ));
        assert!(!supports_ssh_manager(
            &json!({"capabilities": {"ssh_manager": 0}})
        ));
        assert!(!supports_ssh_manager(
            &json!({"capabilities": {"host_bridge": 1}})
        ));
        assert!(!supports_ssh_manager(&json!({"status": "ok"})));
    }

    #[test]
    fn new_host_sends_its_secret_and_associations() {
        let plan = plan_push(
            &desktop(
                vec![desktop_host("web", "hunter2")],
                json!({"/work/app/": ["web", "ghost"]}),
            ),
            &remote(0, vec![], json!({})),
            &NoDigests,
        );
        let body = plan.body.expect("push needed");
        assert!(body.get("baseRevision").is_none());
        assert_eq!(body["hosts"][0]["password"], "hunter2");
        assert_eq!(body["hosts"][0]["proxy"]["clearPassword"], true);
        assert!(body["hosts"][0].get("passwordConfigured").is_none());
        assert!(body["hosts"][0].get("clearPrivateKey").is_none());
        assert_eq!(
            body["projectHostAssociations"],
            json!({"/work/app": ["web"]})
        );
    }

    #[test]
    fn unchanged_secret_is_not_resent_and_matching_state_skips_the_put() {
        let db = memory_db();
        let store = DigestStore::open(&db, "storage-a").unwrap();
        let desktop_doc = desktop(
            vec![desktop_host("web", "hunter2")],
            json!({"/work/app": ["web"]}),
        );
        let first = plan_push(&desktop_doc, &remote(0, vec![], json!({})), &store);
        store.record(&first.secrets).unwrap();

        let store = DigestStore::open(&db, "storage-a").unwrap();
        let synced = remote(
            3,
            vec![remote_host("web", true)],
            json!({"/work/app": ["web"]}),
        );
        let plan = plan_push(&desktop_doc, &synced, &store);
        assert!(plan.body.is_none(), "nothing changed: {:?}", plan.body);

        // A non-secret change is pushed without the unchanged password.
        let mut renamed = desktop_host("web", "hunter2");
        renamed["name"] = json!("web-1");
        let plan = plan_push(
            &desktop(vec![renamed], json!({"/work/app": ["web"]})),
            &synced,
            &store,
        );
        let body = plan.body.expect("rename pushed");
        assert_eq!(body["baseRevision"], 3);
        assert!(body["hosts"][0].get("password").is_none());
        assert!(!body.to_string().contains("hunter2"));
    }

    #[test]
    fn changed_or_missing_secrets_are_sent_and_removed_ones_cleared() {
        let db = memory_db();
        let store = DigestStore::open(&db, "storage-a").unwrap();
        let first = plan_push(
            &desktop(vec![desktop_host("web", "old")], json!({})),
            &remote(0, vec![], json!({})),
            &store,
        );
        store.record(&first.secrets).unwrap();
        let store = DigestStore::open(&db, "storage-a").unwrap();
        let synced = remote(1, vec![remote_host("web", true)], json!({}));

        let changed = plan_push(
            &desktop(vec![desktop_host("web", "new")], json!({})),
            &synced,
            &store,
        );
        assert_eq!(changed.body.unwrap()["hosts"][0]["password"], "new");

        // K-brain lost it (e.g. a fresh data dir): resend even though the digest matches.
        let lost = remote(1, vec![remote_host("web", false)], json!({}));
        let resend = plan_push(
            &desktop(vec![desktop_host("web", "old")], json!({})),
            &lost,
            &store,
        );
        assert_eq!(resend.body.unwrap()["hosts"][0]["password"], "old");

        let cleared = plan_push(
            &desktop(vec![desktop_host("web", "")], json!({})),
            &synced,
            &store,
        );
        let body = cleared.body.expect("clear pushed");
        assert_eq!(body["hosts"][0]["clearPassword"], true);
        assert!(body["hosts"][0].get("password").is_none());

        // Another K-brain storage has no digests: the secret is sent there.
        let other = DigestStore::open(&db, "storage-b").unwrap();
        let plan = plan_push(
            &desktop(vec![desktop_host("web", "old")], json!({})),
            &synced,
            &other,
        );
        assert_eq!(plan.body.unwrap()["hosts"][0]["password"], "old");
    }

    #[test]
    fn auth_type_change_resends_secrets_and_drops_inapplicable_ones() {
        let mut host = desktop_host("web", "pw-left-over");
        host["authType"] = json!("privateKey");
        host["privateKey"] =
            json!("-----BEGIN OPENSSH PRIVATE KEY-----\nkey\n-----END OPENSSH PRIVATE KEY-----\n");
        let plan = plan_push(
            &desktop(vec![host], json!({})),
            &remote(2, vec![remote_host("web", true)], json!({})),
            &NoDigests,
        );
        let body = plan.body.unwrap();
        let sent = &body["hosts"][0];
        assert_eq!(sent["authType"], "privateKey");
        assert!(sent["privateKey"].as_str().unwrap().contains("PRIVATE KEY"));
        assert_eq!(sent["clearPrivateKeyPassphrase"], true);
        assert!(sent.get("password").is_none() && sent.get("clearPassword").is_none());
    }

    #[test]
    fn hosts_kbrain_would_refuse_are_skipped_and_deleted_hosts_dropped() {
        let mut bad = desktop_host("a/b", "x");
        bad["name"] = json!("bad");
        let plan = plan_push(
            &desktop(
                vec![bad, desktop_host("web", "")],
                json!({"/p": ["a/b", "web"]}),
            ),
            &remote(5, vec![remote_host("gone", false)], json!({})),
            &NoDigests,
        );
        assert_eq!(plan.skipped, vec!["a/b".to_string()]);
        let body = plan.body.unwrap();
        let ids: Vec<&str> = body["hosts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|host| host["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, vec!["web"]);
        assert_eq!(body["projectHostAssociations"], json!({"/p": ["web"]}));
    }

    #[test]
    fn digests_are_salted_and_never_store_the_secret() {
        let db = memory_db();
        let store = DigestStore::open(&db, "storage-a").unwrap();
        store
            .record(&[SecretState {
                host_id: "web".into(),
                field: FIELD_PASSWORD,
                value: Some("hunter2".into()),
            }])
            .unwrap();
        let stored: String = db
            .query_row(
                "SELECT digest FROM kbrain_ssh_secret_digests WHERE storage_id = 'storage-a'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!stored.contains("hunter2"));
        let unsalted: String = Sha256::digest(b"hunter2")
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        assert_ne!(stored, unsalted);
        let reopened = DigestStore::open(&db, "storage-a").unwrap();
        assert!(reopened.matches("web", FIELD_PASSWORD, "hunter2"));
        assert!(!reopened.matches("web", FIELD_PASSWORD, "hunter3"));
    }

    /// A scripted K-brain: answers requests in order and hands back what it received.
    fn kbrain_stub(
        responses: Vec<(&'static str, String)>,
    ) -> (
        KBrainBackendConnection,
        mpsc::Receiver<String>,
        thread::JoinHandle<()>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind stub");
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let (tx, rx) = mpsc::channel();
        let handle = thread::spawn(move || {
            for (status, body) in responses {
                let (mut stream, _) = listener.accept().expect("accept");
                let mut request = Vec::new();
                let mut chunk = [0_u8; 4096];
                loop {
                    let read = stream.read(&mut chunk).expect("read");
                    request.extend_from_slice(&chunk[..read]);
                    let text = String::from_utf8_lossy(&request).to_string();
                    if read == 0 {
                        break;
                    }
                    if let Some((head, rest)) = text.split_once("\r\n\r\n") {
                        let length = head
                            .lines()
                            .find_map(|line| {
                                let (name, value) = line.split_once(':')?;
                                name.eq_ignore_ascii_case("content-length")
                                    .then(|| value.trim().parse::<usize>().ok())?
                            })
                            .unwrap_or(0);
                        if rest.len() >= length {
                            break;
                        }
                    }
                }
                tx.send(String::from_utf8_lossy(&request).into_owned())
                    .unwrap();
                let response = format!(
                    "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(response.as_bytes()).expect("write");
            }
        });
        let connection = KBrainBackendConnection {
            base_url,
            token: "test-token".into(),
            protocol_version: "kbrain.agent.v1".into(),
            storage_id: "storage-a".into(),
        };
        (connection, rx, handle)
    }

    fn health(ssh: bool) -> String {
        if ssh {
            json!({"status": "ok", "capabilities": {"ssh_manager": 1}}).to_string()
        } else {
            json!({"status": "ok", "capabilities": {}}).to_string()
        }
    }

    #[test]
    fn older_kbrain_without_the_capability_gets_nothing() {
        let (connection, requests, handle) = kbrain_stub(vec![("200 OK", health(false))]);
        let db = memory_db();
        let outcome = sync_with(
            &client().unwrap(),
            &connection,
            &db,
            &desktop(vec![desktop_host("web", "hunter2")], json!({})),
        )
        .expect("sync");
        handle.join().unwrap();
        assert!(!outcome.supported && !outcome.pushed);
        let all: Vec<String> = requests.try_iter().collect();
        assert_eq!(all.len(), 1);
        assert!(all[0].starts_with("GET /v1/health "));
        assert_eq!(public_state(Ok(outcome), true)["supported"], false);
    }

    #[test]
    fn startup_sync_pushes_then_second_sync_sends_no_secret() {
        let desktop_doc = desktop(
            vec![desktop_host("web", "hunter2")],
            json!({"/work/app": ["web"]}),
        );
        let synced = remote(
            1,
            vec![remote_host("web", true)],
            json!({"/work/app": ["web"]}),
        );
        let (connection, requests, handle) = kbrain_stub(vec![
            ("200 OK", health(true)),
            ("200 OK", remote(0, vec![], json!({})).to_string()),
            ("200 OK", synced.to_string()),
            ("200 OK", health(true)),
            ("200 OK", synced.to_string()),
        ]);
        let db = memory_db();
        let client = client().unwrap();
        let first = sync_with(&client, &connection, &db, &desktop_doc).expect("first sync");
        assert!(first.supported && first.pushed);
        let second = sync_with(&client, &connection, &db, &desktop_doc).expect("second sync");
        assert!(second.supported && !second.pushed);
        handle.join().unwrap();
        let all: Vec<String> = requests.try_iter().collect();
        assert_eq!(all.len(), 5);
        assert!(all[2].starts_with("PUT /v1/settings/ssh "));
        assert!(all[2]
            .to_ascii_lowercase()
            .contains("authorization: bearer test-token"));
        assert!(all[2].contains("hunter2"));
        assert!(all
            .iter()
            .skip(3)
            .all(|request| !request.starts_with("PUT")));
        let state = public_state(Ok(second), true);
        assert_eq!(state["hosts"][0]["credential"], "saved");
    }

    #[test]
    fn conflict_rereads_and_retries_once() {
        let desktop_doc = desktop(vec![desktop_host("web", "hunter2")], json!({}));
        let moved = remote(7, vec![remote_host("other", false)], json!({}));
        let synced = remote(8, vec![remote_host("web", true)], json!({}));
        let (connection, requests, handle) = kbrain_stub(vec![
            ("200 OK", health(true)),
            ("200 OK", remote(6, vec![], json!({})).to_string()),
            (
                "409 Conflict",
                json!({"error": "SSH settings changed; reload and retry"}).to_string(),
            ),
            ("200 OK", moved.to_string()),
            ("200 OK", synced.to_string()),
        ]);
        let db = memory_db();
        let outcome = sync_with(&client().unwrap(), &connection, &db, &desktop_doc).expect("sync");
        handle.join().unwrap();
        assert!(outcome.pushed);
        let all: Vec<String> = requests.try_iter().collect();
        assert!(all[2].contains("\"baseRevision\":6"));
        assert!(all[4].contains("\"baseRevision\":7"));
        // The retry is rebuilt from the new document: still the full list, with the secret.
        assert!(all[4].contains("hunter2"));
    }

    #[test]
    fn repeated_conflict_fails_without_leaking_secrets() {
        let desktop_doc = desktop(vec![desktop_host("web", "hunter2")], json!({}));
        let conflict = json!({"error": "stale revision"}).to_string();
        let (connection, _requests, handle) = kbrain_stub(vec![
            ("200 OK", health(true)),
            ("200 OK", remote(1, vec![], json!({})).to_string()),
            ("409 Conflict", conflict.clone()),
            ("200 OK", remote(2, vec![], json!({})).to_string()),
            ("409 Conflict", conflict),
        ]);
        let db = memory_db();
        let error =
            sync_with(&client().unwrap(), &connection, &db, &desktop_doc).expect_err("conflict");
        handle.join().unwrap();
        assert!(error.contains("stale revision"), "{error}");
        assert!(!error.contains("hunter2"));
        // Nothing was recorded: the next sync sends the secret again.
        let store = DigestStore::open(&db, "storage-a").unwrap();
        assert!(!store.recorded("web", FIELD_PASSWORD));
    }

    #[test]
    fn rejected_push_reports_kbrain_message_only() {
        let desktop_doc = desktop(vec![desktop_host("web", "hunter2")], json!({}));
        let (connection, _requests, handle) = kbrain_stub(vec![
            ("200 OK", health(true)),
            ("200 OK", remote(1, vec![], json!({})).to_string()),
            (
                "400 Bad Request",
                json!({"error": "host \"web\": proxy.url: proxy host is required"}).to_string(),
            ),
        ]);
        let db = memory_db();
        let error =
            sync_with(&client().unwrap(), &connection, &db, &desktop_doc).expect_err("rejected");
        handle.join().unwrap();
        assert!(
            error.contains("proxy host is required") && !error.contains("hunter2"),
            "{error}"
        );
        assert!(!error.contains(&connection.base_url));
    }

    #[test]
    fn host_ids_are_escaped_in_paths() {
        assert_eq!(percent_encode_segment("web 1:a"), "web%201%3Aa");
        assert_eq!(percent_encode_segment("plain-id_1.x"), "plain-id_1.x");
    }
}
