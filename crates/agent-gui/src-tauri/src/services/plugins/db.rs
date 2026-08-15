use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use super::types::{PluginManifest, PluginTrustLevel};

const DB_FILENAME: &str = "plugins.sqlite3";

#[derive(Debug, Clone)]
pub struct StoredPlugin {
    pub manifest: PluginManifest,
    pub package_hash: String,
    pub trust_level: PluginTrustLevel,
    pub global_enabled: bool,
    pub generation: i64,
    pub last_error: Option<String>,
    pub installed_at: i64,
    pub updated_at: i64,
}

/// 解析一次并缓存。`package_path`/`open_db` 都在每次工具调用、每轮快照上被调用，
/// 没必要每次重跑 env 解析与 `create_dir_all`；`LIVEAGENT_PLUGIN_ROOT` 也因此在
/// 进程内保持稳定（隔离测试本来就是按进程设置该变量的）。
pub fn plugins_root() -> Result<PathBuf, String> {
    static ROOT: OnceLock<Result<PathBuf, String>> = OnceLock::new();
    ROOT.get_or_init(|| {
        let root = match std::env::var_os("LIVEAGENT_PLUGIN_ROOT") {
            Some(value) => {
                let root = PathBuf::from(value);
                if !root.is_absolute() {
                    return Err("LIVEAGENT_PLUGIN_ROOT 必须是绝对路径".to_string());
                }
                root
            }
            None => dirs::home_dir()
                .ok_or_else(|| "无法定位用户目录".to_string())?
                .join(format!(".{}", env!("CARGO_PKG_NAME")))
                .join("plugins"),
        };
        fs::create_dir_all(&root).map_err(|error| format!("创建插件目录失败：{error}"))?;
        Ok(root)
    })
    .clone()
}

pub fn open_db() -> Result<Connection, String> {
    static SCHEMA_READY: AtomicBool = AtomicBool::new(false);
    let root = plugins_root()?;
    let connection = Connection::open(root.join(DB_FILENAME))
        .map_err(|error| format!("打开插件数据库失败：{error}"))?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|error| format!("设置插件数据库 busy_timeout 失败：{error}"))?;
    // foreign_keys 是连接级 pragma，必须每条连接都设；建表 DDL 只需跑一次。
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(|error| format!("启用插件数据库外键失败：{error}"))?;
    if !SCHEMA_READY.load(Ordering::Relaxed) {
        initialize_schema(&connection)?;
        SCHEMA_READY.store(true, Ordering::Relaxed);
    }
    Ok(connection)
}

pub fn initialize_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "
            PRAGMA journal_mode = WAL;
            PRAGMA foreign_keys = ON;

            CREATE TABLE IF NOT EXISTS plugins (
                plugin_id TEXT PRIMARY KEY,
                manifest_json TEXT NOT NULL,
                package_hash TEXT NOT NULL,
                trust_level TEXT NOT NULL,
                global_enabled INTEGER NOT NULL DEFAULT 0,
                generation INTEGER NOT NULL DEFAULT 1,
                last_error TEXT,
                installed_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS plugin_scopes (
                plugin_id TEXT NOT NULL,
                workspace_key TEXT NOT NULL,
                enabled INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (plugin_id, workspace_key),
                FOREIGN KEY (plugin_id) REFERENCES plugins(plugin_id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS plugin_config (
                plugin_id TEXT NOT NULL,
                workspace_key TEXT NOT NULL,
                revision INTEGER NOT NULL,
                config_json TEXT NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (plugin_id, workspace_key),
                FOREIGN KEY (plugin_id) REFERENCES plugins(plugin_id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS plugin_grants (
                plugin_id TEXT NOT NULL,
                permission_id TEXT NOT NULL,
                granted_at INTEGER NOT NULL,
                PRIMARY KEY (plugin_id, permission_id),
                FOREIGN KEY (plugin_id) REFERENCES plugins(plugin_id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS plugin_audit (
                audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
                plugin_id TEXT NOT NULL,
                workspace_key TEXT,
                action TEXT NOT NULL,
                detail_json TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_plugin_audit_plugin_created
                ON plugin_audit(plugin_id, created_at DESC);
            ",
        )
        .map_err(|error| format!("初始化插件数据库失败：{error}"))?;
    Ok(())
}

pub fn upsert_plugin(
    connection: &mut Connection,
    manifest: &PluginManifest,
    package_hash: &str,
    trust_level: &PluginTrustLevel,
    granted_permissions: &[String],
) -> Result<i64, String> {
    let now = now_ms();
    let manifest_json = serde_json::to_string(manifest)
        .map_err(|error| format!("序列化插件 Manifest 失败：{error}"))?;
    let trust_level = serde_json::to_string(trust_level)
        .map_err(|error| format!("序列化插件信任级别失败：{error}"))?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("开始插件安装事务失败：{error}"))?;
    let existing = transaction
        .query_row(
            "SELECT generation, installed_at FROM plugins WHERE plugin_id = ?1",
            params![manifest.id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()
        .map_err(|error| format!("读取已安装插件失败：{error}"))?;
    let generation = existing.map(|value| value.0 + 1).unwrap_or(1);
    let installed_at = existing.map(|value| value.1).unwrap_or(now);
    transaction
        .execute(
            "
            INSERT INTO plugins (
                plugin_id, manifest_json, package_hash, trust_level,
                global_enabled, generation, last_error, installed_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, 0, ?5, NULL, ?6, ?7)
            ON CONFLICT(plugin_id) DO UPDATE SET
                manifest_json = excluded.manifest_json,
                package_hash = excluded.package_hash,
                trust_level = excluded.trust_level,
                generation = excluded.generation,
                last_error = NULL,
                updated_at = excluded.updated_at
            ",
            params![
                manifest.id,
                manifest_json,
                package_hash,
                trust_level,
                generation,
                installed_at,
                now
            ],
        )
        .map_err(|error| format!("保存插件安装记录失败：{error}"))?;
    transaction
        .execute(
            "DELETE FROM plugin_grants WHERE plugin_id = ?1",
            params![manifest.id],
        )
        .map_err(|error| format!("更新插件权限前清理旧授权失败：{error}"))?;
    for permission_id in granted_permissions {
        transaction
            .execute(
                "INSERT INTO plugin_grants (plugin_id, permission_id, granted_at) VALUES (?1, ?2, ?3)",
                params![manifest.id, permission_id, now],
            )
            .map_err(|error| format!("保存插件权限授权失败：{error}"))?;
    }
    insert_audit_with_connection(
        &transaction,
        &manifest.id,
        None,
        "install",
        &serde_json::json!({
            "version": manifest.version,
            "packageHash": package_hash,
            "generation": generation
            ,"grantedPermissions": granted_permissions
        }),
    )?;
    transaction
        .commit()
        .map_err(|error| format!("提交插件安装事务失败：{error}"))?;
    Ok(generation)
}

/// Inventory 一次性读全表，替代按插件 N 次查询。
pub fn read_all_grants(connection: &Connection) -> Result<HashMap<String, Vec<String>>, String> {
    let mut statement = connection
        .prepare("SELECT plugin_id, permission_id FROM plugin_grants ORDER BY permission_id")
        .map_err(|error| format!("准备插件权限查询失败：{error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| format!("查询插件权限失败：{error}"))?;
    let mut grants = HashMap::<String, Vec<String>>::new();
    for row in rows {
        let (plugin_id, permission_id) =
            row.map_err(|error| format!("解析插件权限失败：{error}"))?;
        grants.entry(plugin_id).or_default().push(permission_id);
    }
    Ok(grants)
}

/// 读出某个 workspace_key 下的全部启停覆盖；`""` 即全局作用域行。
pub fn read_all_scope_enabled(
    connection: &Connection,
    workspace_key: &str,
) -> Result<HashMap<String, bool>, String> {
    let mut statement = connection
        .prepare("SELECT plugin_id, enabled FROM plugin_scopes WHERE workspace_key = ?1")
        .map_err(|error| format!("准备插件 Workspace 状态查询失败：{error}"))?;
    let rows = statement
        .query_map(params![workspace_key], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?))
        })
        .map_err(|error| format!("查询插件 Workspace 状态失败：{error}"))?;
    rows.collect::<Result<HashMap<_, _>, _>>()
        .map_err(|error| format!("解析插件 Workspace 状态失败：{error}"))
}

/// 读出某个 workspace_key 下的全部配置及 revision；`""` 即全局作用域行。
pub fn read_all_configs(
    connection: &Connection,
    workspace_key: &str,
) -> Result<HashMap<String, (Value, i64)>, String> {
    let mut statement = connection
        .prepare(
            "SELECT plugin_id, config_json, revision FROM plugin_config WHERE workspace_key = ?1",
        )
        .map_err(|error| format!("准备插件配置查询失败：{error}"))?;
    let rows = statement
        .query_map(params![workspace_key], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .map_err(|error| format!("查询插件配置失败：{error}"))?;
    let mut configs = HashMap::new();
    for row in rows {
        let (plugin_id, json, revision) =
            row.map_err(|error| format!("解析插件配置失败：{error}"))?;
        let config =
            serde_json::from_str(&json).map_err(|error| format!("解析插件配置失败：{error}"))?;
        configs.insert(plugin_id, (config, revision));
    }
    Ok(configs)
}

pub fn replace_grants(
    connection: &mut Connection,
    plugin_id: &str,
    permissions: &[String],
) -> Result<i64, String> {
    let now = now_ms();
    let transaction = connection
        .transaction()
        .map_err(|error| format!("开始插件权限事务失败：{error}"))?;
    let generation: i64 = transaction
        .query_row(
            "SELECT generation FROM plugins WHERE plugin_id = ?1",
            params![plugin_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| format!("读取插件 generation 失败：{error}"))?
        .ok_or_else(|| format!("插件未安装：{plugin_id}"))?
        + 1;
    transaction
        .execute(
            "DELETE FROM plugin_grants WHERE plugin_id = ?1",
            params![plugin_id],
        )
        .map_err(|error| format!("清理插件权限失败：{error}"))?;
    for permission in permissions {
        transaction
            .execute(
                "INSERT INTO plugin_grants (plugin_id, permission_id, granted_at) VALUES (?1, ?2, ?3)",
                params![plugin_id, permission, now],
            )
            .map_err(|error| format!("保存插件权限失败：{error}"))?;
    }
    transaction
        .execute(
            "UPDATE plugins SET generation = ?2, last_error = NULL, updated_at = ?3 WHERE plugin_id = ?1",
            params![plugin_id, generation, now],
        )
        .map_err(|error| format!("更新插件 generation 失败：{error}"))?;
    insert_audit_with_connection(
        &transaction,
        plugin_id,
        None,
        "grant",
        &serde_json::json!({ "permissions": permissions, "generation": generation }),
    )?;
    transaction
        .commit()
        .map_err(|error| format!("提交插件权限事务失败：{error}"))?;
    Ok(generation)
}

pub fn list_plugins(connection: &Connection) -> Result<Vec<StoredPlugin>, String> {
    let mut statement = connection
        .prepare(
            "
            SELECT manifest_json, package_hash, trust_level, global_enabled,
                   generation, last_error, installed_at, updated_at
            FROM plugins
            ORDER BY plugin_id COLLATE NOCASE
            ",
        )
        .map_err(|error| format!("准备插件列表查询失败：{error}"))?;
    let rows = statement
        .query_map([], row_to_stored_plugin)
        .map_err(|error| format!("查询插件列表失败：{error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("解析插件列表失败：{error}"))
}

pub fn get_plugin(connection: &Connection, plugin_id: &str) -> Result<StoredPlugin, String> {
    connection
        .query_row(
            "
            SELECT manifest_json, package_hash, trust_level, global_enabled,
                   generation, last_error, installed_at, updated_at
            FROM plugins WHERE plugin_id = ?1
            ",
            params![plugin_id],
            row_to_stored_plugin,
        )
        .optional()
        .map_err(|error| format!("读取插件失败：{error}"))?
        .ok_or_else(|| format!("插件未安装：{plugin_id}"))
}

pub fn set_enabled(
    connection: &mut Connection,
    plugin_id: &str,
    workspace: Option<&str>,
    enabled: bool,
) -> Result<i64, String> {
    let now = now_ms();
    let transaction = connection
        .transaction()
        .map_err(|error| format!("开始插件启停事务失败：{error}"))?;
    let generation: i64 = transaction
        .query_row(
            "SELECT generation FROM plugins WHERE plugin_id = ?1",
            params![plugin_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| format!("读取插件 generation 失败：{error}"))?
        .ok_or_else(|| format!("插件未安装：{plugin_id}"))?
        + 1;
    let workspace_key_value = workspace.map(workspace_key).transpose()?;
    if let Some(workspace_key) = workspace_key_value.as_deref() {
        transaction
            .execute(
                "
                INSERT INTO plugin_scopes (plugin_id, workspace_key, enabled, updated_at)
                VALUES (?1, ?2, ?3, ?4)
                ON CONFLICT(plugin_id, workspace_key) DO UPDATE SET
                    enabled = excluded.enabled,
                    updated_at = excluded.updated_at
                ",
                params![plugin_id, workspace_key, enabled, now],
            )
            .map_err(|error| format!("保存插件 Workspace 状态失败：{error}"))?;
    } else {
        transaction
            .execute(
                "UPDATE plugins SET global_enabled = ?2, updated_at = ?3 WHERE plugin_id = ?1",
                params![plugin_id, enabled, now],
            )
            .map_err(|error| format!("保存插件全局状态失败：{error}"))?;
    }
    transaction
        .execute(
            "UPDATE plugins SET generation = ?2, last_error = NULL, updated_at = ?3 WHERE plugin_id = ?1",
            params![plugin_id, generation, now],
        )
        .map_err(|error| format!("更新插件 generation 失败：{error}"))?;
    insert_audit_with_connection(
        &transaction,
        plugin_id,
        workspace_key_value.as_deref(),
        if enabled { "enable" } else { "disable" },
        &serde_json::json!({ "generation": generation }),
    )?;
    transaction
        .commit()
        .map_err(|error| format!("提交插件启停事务失败：{error}"))?;
    Ok(generation)
}

pub fn uninstall_plugin(connection: &mut Connection, plugin_id: &str) -> Result<String, String> {
    let transaction = connection
        .transaction()
        .map_err(|error| format!("开始插件卸载事务失败：{error}"))?;
    let package_hash: String = transaction
        .query_row(
            "SELECT package_hash FROM plugins WHERE plugin_id = ?1",
            params![plugin_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("读取卸载插件失败：{error}"))?
        .ok_or_else(|| format!("插件未安装：{plugin_id}"))?;
    insert_audit_with_connection(
        &transaction,
        plugin_id,
        None,
        "uninstall",
        &serde_json::json!({ "packageHash": package_hash }),
    )?;
    transaction
        .execute(
            "DELETE FROM plugins WHERE plugin_id = ?1",
            params![plugin_id],
        )
        .map_err(|error| format!("删除插件记录失败：{error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("提交插件卸载事务失败：{error}"))?;
    Ok(package_hash)
}

pub fn read_config(
    connection: &Connection,
    plugin_id: &str,
    workspace: Option<&str>,
) -> Result<(Value, i64), String> {
    let workspace_key = workspace
        .map(workspace_key)
        .transpose()?
        .unwrap_or_default();
    let value = connection
        .query_row(
            "SELECT config_json, revision FROM plugin_config WHERE plugin_id = ?1 AND workspace_key = ?2",
            params![plugin_id, workspace_key],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()
        .map_err(|error| format!("读取插件配置失败：{error}"))?;
    let Some((json, revision)) = value else {
        return Ok((serde_json::json!({}), 0));
    };
    let config =
        serde_json::from_str(&json).map_err(|error| format!("解析插件配置失败：{error}"))?;
    Ok((config, revision))
}

pub fn read_effective_config(
    connection: &Connection,
    plugin_id: &str,
    workspace: Option<&str>,
) -> Result<(Value, i64), String> {
    let scoped = read_config(connection, plugin_id, workspace)?;
    if workspace.is_some() && scoped.1 == 0 {
        let (global_config, _) = read_config(connection, plugin_id, None)?;
        return Ok((global_config, 0));
    }
    Ok(scoped)
}

pub fn update_config(
    connection: &mut Connection,
    plugin_id: &str,
    workspace: Option<&str>,
    expected_revision: i64,
    config: &Value,
) -> Result<i64, String> {
    let workspace_key_value = workspace.map(workspace_key).transpose()?;
    let workspace_key = workspace_key_value.as_deref().unwrap_or_default();
    let now = now_ms();
    let config_json =
        serde_json::to_string(config).map_err(|error| format!("序列化插件配置失败：{error}"))?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("开始插件配置事务失败：{error}"))?;
    let current_revision = transaction
        .query_row(
            "SELECT revision FROM plugin_config WHERE plugin_id = ?1 AND workspace_key = ?2",
            params![plugin_id, workspace_key],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| format!("读取插件配置 revision 失败：{error}"))?
        .unwrap_or(0);
    if current_revision != expected_revision {
        return Err(format!(
            "插件配置已变化，期望 revision {expected_revision}，实际为 {current_revision}"
        ));
    }
    let next_revision = current_revision + 1;
    transaction
        .execute(
            "
            INSERT INTO plugin_config (plugin_id, workspace_key, revision, config_json, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5)
            ON CONFLICT(plugin_id, workspace_key) DO UPDATE SET
                revision = excluded.revision,
                config_json = excluded.config_json,
                updated_at = excluded.updated_at
            ",
            params![plugin_id, workspace_key, next_revision, config_json, now],
        )
        .map_err(|error| format!("保存插件配置失败：{error}"))?;
    transaction
        .execute(
            "UPDATE plugins SET generation = generation + 1, updated_at = ?2 WHERE plugin_id = ?1",
            params![plugin_id, now],
        )
        .map_err(|error| format!("更新插件 generation 失败：{error}"))?;
    insert_audit_with_connection(
        &transaction,
        plugin_id,
        workspace_key_value.as_deref(),
        "configure",
        &serde_json::json!({ "revision": next_revision }),
    )?;
    transaction
        .commit()
        .map_err(|error| format!("提交插件配置事务失败：{error}"))?;
    Ok(next_revision)
}

pub fn record_failure(connection: &Connection, plugin_id: &str, error: &str) -> Result<(), String> {
    connection
        .execute(
            "UPDATE plugins SET last_error = ?2, updated_at = ?3 WHERE plugin_id = ?1",
            params![plugin_id, error, now_ms()],
        )
        .map_err(|db_error| format!("记录插件失败状态失败：{db_error}"))?;
    insert_audit_with_connection(
        connection,
        plugin_id,
        None,
        "failure",
        &serde_json::json!({ "error": error }),
    )
}

pub fn clear_failure(connection: &Connection, plugin_id: &str) -> Result<(), String> {
    connection
        .execute(
            "UPDATE plugins SET last_error = NULL WHERE plugin_id = ?1",
            params![plugin_id],
        )
        .map_err(|error| format!("清除插件失败状态失败：{error}"))?;
    Ok(())
}

pub fn package_path(package_hash: &str) -> Result<PathBuf, String> {
    if package_hash.len() != 64 || !package_hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("插件 package hash 格式无效".to_string());
    }
    Ok(plugins_root()?.join("store").join(package_hash))
}

pub fn workspace_key(workspace: &str) -> Result<String, String> {
    let trimmed = workspace.trim();
    if trimmed.is_empty() {
        return Err("Workspace 路径不能为空".to_string());
    }
    let path = Path::new(trimmed);
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("解析 Workspace 路径失败：{error}"))?;
    if !canonical.is_dir() {
        return Err("Workspace 路径不是目录".to_string());
    }
    Ok(canonical.to_string_lossy().into_owned())
}

fn row_to_stored_plugin(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredPlugin> {
    let manifest_json: String = row.get(0)?;
    let trust_level_json: String = row.get(2)?;
    let manifest = serde_json::from_str(&manifest_json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            manifest_json.len(),
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })?;
    let trust_level = serde_json::from_str(&trust_level_json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            trust_level_json.len(),
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })?;
    Ok(StoredPlugin {
        manifest,
        package_hash: row.get(1)?,
        trust_level,
        global_enabled: row.get(3)?,
        generation: row.get(4)?,
        last_error: row.get(5)?,
        installed_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

fn insert_audit_with_connection(
    connection: &Connection,
    plugin_id: &str,
    workspace_key: Option<&str>,
    action: &str,
    detail: &Value,
) -> Result<(), String> {
    let detail_json = serde_json::to_string(detail)
        .map_err(|error| format!("序列化插件审计信息失败：{error}"))?;
    connection
        .execute(
            "
            INSERT INTO plugin_audit (plugin_id, workspace_key, action, detail_json, created_at)
            VALUES (?1, ?2, ?3, ?4, ?5)
            ",
            params![plugin_id, workspace_key, action, detail_json, now_ms()],
        )
        .map_err(|error| format!("写入插件审计记录失败：{error}"))?;
    Ok(())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
