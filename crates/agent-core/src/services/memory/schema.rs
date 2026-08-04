fn open_memory_connection(db_path: &Path) -> Result<Connection, String> {
    if let Some(parent) = db_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建记忆数据库目录失败：{e}"))?;
    }
    let conn = Connection::open(db_path).map_err(|e| format!("打开记忆数据库失败：{e}"))?;
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(|e| format!("设置记忆数据库 busy_timeout 失败：{e}"))?;
    if let Err(error) = integrity_check(&conn) {
        quarantine_db_files(db_path)?;
        drop(conn);
        let conn = Connection::open(db_path).map_err(|e| format!("重建记忆数据库失败：{e}"))?;
        conn.busy_timeout(Duration::from_secs(5))
            .map_err(|e| format!("设置记忆数据库 busy_timeout 失败：{e}"))?;
        init_schema(&conn)?;
        eprintln!("memory index was quarantined and rebuilt: {error}");
        return Ok(conn);
    }
    init_schema(&conn)?;
    Ok(conn)
}

fn init_schema(conn: &Connection) -> Result<(), String> {
    if memory_schema_needs_rebuild(conn)? {
        conn.execute_batch(
            "DROP TABLE IF EXISTS memory_fts;
             DROP TABLE IF EXISTS memory_fts_tri;
             DROP TABLE IF EXISTS memory_meta;
             DROP TABLE IF EXISTS memory_audit_log;
             DROP TABLE IF EXISTS memory_schema_version;",
        )
        .map_err(|e| format!("重建旧版记忆索引表失败：{e}"))?;
    }
    conn.execute_batch(MEMORY_SCHEMA_DDL)
        .map_err(|e| format!("初始化记忆索引表失败：{e}"))?;
    ensure_organize_runs_v4_columns(conn)
}

/// v3 -> v4 is additive: organize-run history survives, missing columns are
/// added in place. The CREATE TABLE in MEMORY_SCHEMA_DDL only covers fresh DBs.
fn ensure_organize_runs_v4_columns(conn: &Connection) -> Result<(), String> {
    let columns = table_columns(conn, "memory_organize_runs")?;
    let additions: [(&str, &str); 8] = [
        ("phase", "TEXT"),
        ("final_count", "INTEGER NOT NULL DEFAULT 0"),
        ("compression_ratio", "REAL"),
        ("compression_target", "INTEGER"),
        ("dry_run", "INTEGER NOT NULL DEFAULT 0"),
        ("token_usage_total", "INTEGER NOT NULL DEFAULT 0"),
        ("quota_headroom_at_start", "INTEGER"),
        ("override_reviewed", "INTEGER NOT NULL DEFAULT 0"),
    ];
    for (name, declaration) in additions {
        if !columns.contains(name) {
            conn.execute(
                &format!("ALTER TABLE memory_organize_runs ADD COLUMN {name} {declaration}"),
                [],
            )
            .map_err(|e| format!("迁移 memory_organize_runs 列 {name} 失败：{e}"))?;
        }
    }
    Ok(())
}

fn memory_schema_needs_rebuild(conn: &Connection) -> Result<bool, String> {
    if !sqlite_table_exists(conn, "memory_meta")? {
        return Ok(false);
    }
    if !sqlite_table_exists(conn, "memory_schema_version")? {
        return Ok(true);
    }

    let version = conn
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM memory_schema_version",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|e| format!("读取记忆 schema 版本失败：{e}"))?;
    if version < 3 {
        return Ok(true);
    }
    if version > 4 {
        return Err(format!("unsupported memory schema version: {version}"));
    }

    let meta_columns = table_columns(conn, "memory_meta")?;
    for column in [
        "scope",
        "workdir_hash",
        "slug",
        "type",
        "description",
        "headline",
        "date_local",
        "age_anchor",
        "append_count",
        "archived",
        "body_hash",
        "file_mtime",
        "file_size",
        "created_at",
        "updated_at",
        "source_json",
        "links_json",
    ] {
        if !meta_columns.contains(column) {
            return Ok(true);
        }
    }

    if sqlite_table_exists(conn, "memory_fts")? {
        let fts_columns = table_columns(conn, "memory_fts")?;
        if !fts_columns.contains("headline") {
            return Ok(true);
        }
    }
    if sqlite_table_exists(conn, "memory_fts_tri")? {
        let fts_tri_columns = table_columns(conn, "memory_fts_tri")?;
        if !fts_tri_columns.contains("description") || !fts_tri_columns.contains("headline") {
            return Ok(true);
        }
    }

    Ok(false)
}

fn sqlite_table_exists(conn: &Connection, name: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type IN ('table','virtual table') AND name = ?1)",
        [name],
        |row| row.get::<_, i64>(0),
    )
    .map(|value| value != 0)
    .map_err(|e| format!("检查记忆索引表是否存在失败：{e}"))
}

fn table_columns(conn: &Connection, table: &str) -> Result<HashSet<String>, String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|e| format!("读取记忆索引表列失败：{e}"))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| format!("读取记忆索引表列失败：{e}"))?;
    let mut out = HashSet::new();
    for row in rows {
        out.insert(row.map_err(|e| format!("读取记忆索引表列失败：{e}"))?);
    }
    Ok(out)
}

fn integrity_check(conn: &Connection) -> Result<(), String> {
    let result = conn
        .query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
        .map_err(|e| format!("记忆数据库 integrity_check 失败：{e}"))?;
    if result == "ok" {
        Ok(())
    } else {
        Err(format!("记忆数据库 integrity_check 异常：{result}"))
    }
}

fn quarantine_db_files(db_path: &Path) -> Result<(), String> {
    let root = db_path
        .parent()
        .ok_or_else(|| "memory db path has no parent".to_string())?;
    let quarantine = root
        .join(".quarantine")
        .join(format!("corrupt-{}", now_ms()));
    fs::create_dir_all(&quarantine).map_err(|e| format!("创建记忆数据库隔离目录失败：{e}"))?;
    for suffix in ["", "-wal", "-shm"] {
        let src = PathBuf::from(format!("{}{}", db_path.to_string_lossy(), suffix));
        if src.exists() {
            let file_name = src
                .file_name()
                .map(|name| name.to_os_string())
                .unwrap_or_else(|| format!("memory-index.sqlite3{suffix}").into());
            fs::rename(&src, quarantine.join(file_name))
                .map_err(|e| format!("隔离损坏记忆数据库失败：{e}"))?;
        }
    }
    Ok(())
}
fn index_parsed_file(
    conn: &mut Connection,
    parsed: &ParsedMemoryFile,
    path: &Path,
    archived: bool,
) -> Result<(), String> {
    let slug = normalize_index_slug(&parsed.meta, path)?;
    let scope = normalize_index_scope(&parsed.meta)?;
    let memory_type = normalize_index_type(&parsed.meta)?;
    let workdir_hash = if scope == "project" {
        path.parent()
            .and_then(|parent| parent.file_name())
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .to_string()
    } else {
        String::new()
    };
    let metadata = fs::metadata(path).map_err(|e| format!("读取记忆文件元数据失败：{e}"))?;
    let file_mtime = metadata
        .modified()
        .ok()
        .and_then(system_time_to_ms)
        .unwrap_or_else(now_ms);
    let file_size = metadata.len() as i64;
    let created_at = parsed
        .meta
        .created_at
        .as_deref()
        .and_then(parse_rfc3339_ms)
        .unwrap_or(file_mtime);
    let updated_at = parsed
        .meta
        .updated_at
        .as_deref()
        .and_then(parse_rfc3339_ms)
        .unwrap_or(file_mtime);
    let date_local = if memory_type == "daily" {
        parsed
            .meta
            .date
            .clone()
            .or_else(|| Some(slug.trim_start_matches("daily-").to_string()))
    } else {
        None
    };
    let indexed_headline = if memory_type == "daily" {
        daily_title_for_meta(&parsed.meta.name, date_local.as_deref())
    } else {
        parsed.meta.headline.clone()
    };
    let age_anchor = date_local
        .as_deref()
        .and_then(|date| NaiveDate::parse_from_str(date, "%Y-%m-%d").ok())
        .and_then(|date| date.and_hms_opt(0, 0, 0))
        .and_then(|dt| Local.from_local_datetime(&dt).single())
        .map(|dt| dt.timestamp());
    let confidence = if memory_type == "daily" {
        MEMORY_CONFIDENCE_UNKNOWN.to_string()
    } else {
        evidence_confidence_from_body(&parsed.body)
    };
    let source_for_index = if memory_type == "daily" {
        parsed.meta.source_json.clone()
    } else {
        source_json_with_confidence(parsed.meta.source_json.clone(), &confidence)
    };
    let source_json =
        serde_json::to_string(&source_for_index).map_err(|e| format!("序列化记忆来源失败：{e}"))?;
    let links_json = serde_json::to_string(&parsed.meta.links_json)
        .map_err(|e| format!("序列化记忆链接失败：{e}"))?;
    let body_hash = sha256_hex(parsed.body.as_bytes());
    let tx = conn
        .transaction()
        .map_err(|e| format!("开启记忆索引事务失败：{e}"))?;
    upsert_index_rows(
        &tx,
        &scope,
        &workdir_hash,
        &slug,
        &memory_type,
        &parsed.meta.description,
        &indexed_headline,
        date_local.as_deref(),
        age_anchor,
        parsed.meta.append_count,
        archived,
        &body_hash,
        file_mtime,
        file_size,
        created_at,
        updated_at,
        &source_json,
        &links_json,
        &parsed.body,
    )?;
    tx.commit()
        .map_err(|e| format!("提交记忆索引事务失败：{e}"))
}

#[allow(clippy::too_many_arguments)]
fn upsert_index_rows(
    tx: &Transaction<'_>,
    scope: &str,
    workdir_hash: &str,
    slug: &str,
    memory_type: &str,
    description: &str,
    headline: &str,
    date_local: Option<&str>,
    age_anchor: Option<i64>,
    append_count: i64,
    archived: bool,
    body_hash: &str,
    file_mtime: i64,
    file_size: i64,
    created_at: i64,
    updated_at: i64,
    source_json: &str,
    links_json: &str,
    body: &str,
) -> Result<(), String> {
    tx.execute(
        "
        INSERT OR REPLACE INTO memory_meta
            (scope, workdir_hash, slug, type, description, headline, date_local, age_anchor,
             append_count, archived, body_hash, file_mtime, file_size, created_at, updated_at,
             source_json, links_json)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
        ",
        params![
            scope,
            workdir_hash,
            slug,
            memory_type,
            description,
            headline,
            date_local,
            age_anchor,
            append_count,
            if archived { 1 } else { 0 },
            body_hash,
            file_mtime,
            file_size,
            created_at,
            updated_at,
            source_json,
            links_json
        ],
    )
    .map_err(|e| format!("写入 memory_meta 失败：{e}"))?;
    tx.execute(
        "DELETE FROM memory_fts WHERE scope = ?1 AND workdir_hash = ?2 AND slug = ?3",
        params![scope, workdir_hash, slug],
    )
    .map_err(|e| format!("删除旧 memory_fts 行失败：{e}"))?;
    tx.execute(
        "INSERT INTO memory_fts (slug, scope, workdir_hash, type, description, headline, body)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            slug,
            scope,
            workdir_hash,
            memory_type,
            description,
            headline,
            body
        ],
    )
    .map_err(|e| format!("写入 memory_fts 失败：{e}"))?;
    tx.execute(
        "DELETE FROM memory_fts_tri WHERE scope = ?1 AND workdir_hash = ?2 AND slug = ?3",
        params![scope, workdir_hash, slug],
    )
    .map_err(|e| format!("删除旧 memory_fts_tri 行失败：{e}"))?;
    tx.execute(
        "INSERT INTO memory_fts_tri (slug, scope, workdir_hash, description, headline, body)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![slug, scope, workdir_hash, description, headline, body],
    )
    .map_err(|e| format!("写入 memory_fts_tri 失败：{e}"))?;
    Ok(())
}

fn delete_index_rows(
    conn: &mut Connection,
    scope: &str,
    workdir_hash: &str,
    slug: &str,
) -> Result<(), String> {
    let tx = conn
        .transaction()
        .map_err(|e| format!("开启记忆删除事务失败：{e}"))?;
    tx.execute(
        "DELETE FROM memory_meta WHERE scope = ?1 AND workdir_hash = ?2 AND slug = ?3",
        params![scope, workdir_hash, slug],
    )
    .map_err(|e| format!("删除 memory_meta 行失败：{e}"))?;
    tx.execute(
        "DELETE FROM memory_fts WHERE scope = ?1 AND workdir_hash = ?2 AND slug = ?3",
        params![scope, workdir_hash, slug],
    )
    .map_err(|e| format!("删除 memory_fts 行失败：{e}"))?;
    tx.execute(
        "DELETE FROM memory_fts_tri WHERE scope = ?1 AND workdir_hash = ?2 AND slug = ?3",
        params![scope, workdir_hash, slug],
    )
    .map_err(|e| format!("删除 memory_fts_tri 行失败：{e}"))?;
    tx.commit()
        .map_err(|e| format!("提交记忆删除事务失败：{e}"))
}

fn delete_project_index_rows(
    conn: &mut Connection,
    workdir_hash: &str,
    workdir: &str,
    deleted_count: usize,
    quarantine_path: Option<&Path>,
    actor: &str,
    reason: Option<&str>,
) -> Result<(), String> {
    let tx = conn
        .transaction()
        .map_err(|e| format!("开启项目记忆删除事务失败：{e}"))?;
    tx.execute(
        "DELETE FROM memory_meta WHERE scope = 'project' AND workdir_hash = ?1",
        params![workdir_hash],
    )
    .map_err(|e| format!("删除项目 memory_meta 行失败：{e}"))?;
    tx.execute(
        "DELETE FROM memory_fts WHERE scope = 'project' AND workdir_hash = ?1",
        params![workdir_hash],
    )
    .map_err(|e| format!("删除项目 memory_fts 行失败：{e}"))?;
    tx.execute(
        "DELETE FROM memory_fts_tri WHERE scope = 'project' AND workdir_hash = ?1",
        params![workdir_hash],
    )
    .map_err(|e| format!("删除项目 memory_fts_tri 行失败：{e}"))?;

    let mut detail = json!({
        "workdir": workdir,
        "deletedCount": deleted_count,
    });
    if let Some(path) = quarantine_path {
        detail["quarantinePath"] = Value::String(path.to_string_lossy().to_string());
    }
    if let Some(reason) = reason {
        detail["reason"] = Value::String(reason.to_string());
    }
    let detail_json = serde_json::to_string(&detail).unwrap_or_else(|_| "{}".to_string());
    tx.execute(
        "
        INSERT INTO memory_audit_log
            (ts, op, scope, workdir_hash, slug, actor, detail_json)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        ",
        params![
            now_ms(),
            "delete",
            "project",
            workdir_hash,
            "*",
            actor,
            detail_json
        ],
    )
    .map_err(|e| format!("写入项目记忆删除审计日志失败：{e}"))?;
    tx.commit()
        .map_err(|e| format!("提交项目记忆删除事务失败：{e}"))
}

#[allow(clippy::too_many_arguments)]
fn insert_audit_log(
    conn: &mut Connection,
    op: &str,
    scope: &str,
    workdir_hash: &str,
    slug: &str,
    actor: &str,
    conversation_id: Option<&str>,
    trigger: Option<&str>,
    model: Option<&str>,
    detail: Value,
) -> Result<(), String> {
    let detail_json = serde_json::to_string(&detail).unwrap_or_else(|_| "{}".to_string());
    conn.execute(
        "
        INSERT INTO memory_audit_log
            (ts, op, scope, workdir_hash, slug, actor, conversation_id, trigger, model, detail_json)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
        ",
        params![
            now_ms(),
            op,
            scope,
            workdir_hash,
            slug,
            actor,
            conversation_id,
            trigger,
            model,
            detail_json
        ],
    )
    .map(|_| ())
    .map_err(|e| format!("写入记忆审计日志失败：{e}"))
}

fn load_all_meta(conn: &Connection) -> Result<Vec<MemoryMeta>, String> {
    let mut stmt = conn
        .prepare(
            "
            SELECT scope, workdir_hash, slug, type, description, headline, date_local,
                   created_at, updated_at, append_count, archived, source_json, file_size
            FROM memory_meta
            ",
        )
        .map_err(|e| format!("准备记忆列表查询失败：{e}"))?;
    let rows = stmt
        .query_map([], |row| {
            let source_json: Option<String> = row.get(11)?;
            let source_value = source_json
                .as_deref()
                .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
                .unwrap_or(Value::Null);
            Ok(normalize_memory_meta(MemoryMeta {
                scope: row.get(0)?,
                workdir_hash: row.get(1)?,
                workdir_path: None,
                slug: row.get(2)?,
                memory_type: row.get(3)?,
                description: row.get(4)?,
                headline: row.get(5)?,
                date_local: row.get(6)?,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
                append_count: row.get(9)?,
                archived: row.get::<_, i64>(10)? != 0,
                unreviewed: source_value
                    .get("unreviewed")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                confidence: source_value
                    .get("confidence")
                    .and_then(Value::as_str)
                    .map(normalize_memory_confidence)
                    .unwrap_or_else(|| MEMORY_CONFIDENCE_UNKNOWN.to_string()),
                file_size: row.get(12)?,
            }))
        })
        .map_err(|e| format!("查询记忆列表失败：{e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取记忆列表失败：{e}"))
}

fn count_non_daily_entries(
    conn: &Connection,
    scope: Option<(&str, &str)>,
) -> Result<usize, String> {
    let count = if let Some((scope, workdir_hash)) = scope {
        conn.query_row(
            "SELECT COUNT(*) FROM memory_meta WHERE type != 'daily' AND scope = ?1 AND workdir_hash = ?2",
            params![scope, workdir_hash],
            |row| row.get::<_, i64>(0),
        )
    } else {
        conn.query_row(
            "SELECT COUNT(*) FROM memory_meta WHERE type != 'daily'",
            [],
            |row| row.get::<_, i64>(0),
        )
    }
    .map_err(|e| format!("读取记忆配额失败：{e}"))?;
    Ok(count.max(0) as usize)
}

fn build_list_quota(
    conn: &Connection,
    workdir_hash: Option<&str>,
    scope_filter: Option<&str>,
) -> Result<MemoryQuota, String> {
    let mut scope_quotas = Vec::new();

    if scope_filter.is_none() || scope_filter == Some("global") {
        scope_quotas.push(MemoryScopeQuota {
            scope: "global".to_string(),
            workdir_hash: String::new(),
            used: count_non_daily_entries(conn, Some(("global", "")))?,
            limit: MAX_SCOPE_ENTRIES,
        });
    }

    if scope_filter.is_none() || scope_filter == Some("project") {
        if let Some(hash) = workdir_hash {
            scope_quotas.push(MemoryScopeQuota {
                scope: "project".to_string(),
                workdir_hash: hash.to_string(),
                used: count_non_daily_entries(conn, Some(("project", hash)))?,
                limit: MAX_SCOPE_ENTRIES,
            });
        } else if scope_filter == Some("project") {
            scope_quotas.push(MemoryScopeQuota {
                scope: "project".to_string(),
                workdir_hash: String::new(),
                used: 0,
                limit: MAX_SCOPE_ENTRIES,
            });
        }
    }

    let used = scope_quotas
        .iter()
        .map(|quota| quota.used)
        .max()
        .unwrap_or(0);

    Ok(MemoryQuota {
        used,
        limit: MAX_SCOPE_ENTRIES,
        scope_quotas,
    })
}

impl MemoryStore {
    pub fn quota_summary(
        &self,
        args: MemoryQuotaSummaryArgs,
    ) -> Result<MemoryQuotaSummaryResponse, String> {
        let workdir_hash = match args
            .workdir
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            Some(workdir) => Some(workdir_hash(workdir)?),
            None => None,
        };
        let conn = self.lock_conn()?;
        let mut scopes = vec![scope_quota_summary(&conn, "global", "")?];
        if let Some(hash) = workdir_hash {
            scopes.push(scope_quota_summary(&conn, "project", &hash)?);
        }
        Ok(MemoryQuotaSummaryResponse { scopes })
    }
}

fn scope_quota_summary(
    conn: &Connection,
    scope: &str,
    workdir_hash: &str,
) -> Result<MemoryQuotaScopeSummary, String> {
    let used = count_non_daily_entries(conn, Some((scope, workdir_hash)))?;
    let archived_count = conn
        .query_row(
            "SELECT COUNT(*) FROM memory_meta WHERE archived = 1 AND scope = ?1 AND workdir_hash = ?2",
            params![scope, workdir_hash],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|e| format!("读取归档记忆数量失败：{e}"))?
        .max(0) as usize;

    // `unreviewed` lives inside source_json, so fold in Rust (<=500 rows/scope).
    let mut stmt = conn
        .prepare(
            "SELECT created_at, source_json FROM memory_meta
             WHERE type != 'daily' AND scope = ?1 AND workdir_hash = ?2",
        )
        .map_err(|e| format!("准备记忆配额扫描失败：{e}"))?;
    let rows = stmt
        .query_map(params![scope, workdir_hash], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?))
        })
        .map_err(|e| format!("扫描记忆配额失败：{e}"))?;
    let mut unreviewed_count = 0usize;
    let mut oldest_unreviewed: Option<i64> = None;
    for row in rows {
        let (created_at, source_json) = row.map_err(|e| format!("读取记忆配额行失败：{e}"))?;
        let unreviewed = source_json
            .as_deref()
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
            .and_then(|value| value.get("unreviewed").and_then(Value::as_bool))
            .unwrap_or(false);
        if unreviewed {
            unreviewed_count += 1;
            oldest_unreviewed = Some(match oldest_unreviewed {
                Some(current) => current.min(created_at),
                None => created_at,
            });
        }
    }
    let oldest_unreviewed_age_days = oldest_unreviewed
        .map(|created_at| ((now_ms() - created_at) as f64 / 86_400_000.0).max(0.0));

    Ok(MemoryQuotaScopeSummary {
        scope: scope.to_string(),
        workdir_hash: workdir_hash.to_string(),
        used,
        limit: MAX_SCOPE_ENTRIES,
        headroom: MAX_SCOPE_ENTRIES.saturating_sub(used),
        archived_count,
        unreviewed_count,
        oldest_unreviewed_age_days,
    })
}
fn normalize_memory_meta(mut meta: MemoryMeta) -> MemoryMeta {
    meta.confidence = normalize_memory_confidence(&meta.confidence);
    if meta.memory_type == "daily" {
        meta.headline = daily_title_for_meta(&meta.slug, meta.date_local.as_deref());
        meta.confidence = MEMORY_CONFIDENCE_UNKNOWN.to_string();
    }
    meta
}
fn normalize_index_slug(meta: &ParsedFrontmatter, path: &Path) -> Result<String, String> {
    if meta.memory_type == "daily" {
        let slug = if meta.name.starts_with("daily-") {
            meta.name.clone()
        } else {
            let stem = path
                .file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or_default();
            format!("daily-{stem}")
        };
        normalize_daily_slug(&slug)
    } else {
        normalize_slug(&meta.name)
    }
}

fn normalize_index_scope(meta: &ParsedFrontmatter) -> Result<String, String> {
    match meta.scope.as_str() {
        "global" | "project" => Ok(meta.scope.clone()),
        _ => Err(format!("invalid memory scope: {}", meta.scope)),
    }
}

fn normalize_index_type(meta: &ParsedFrontmatter) -> Result<String, String> {
    if meta.memory_type == "daily" {
        Ok("daily".to_string())
    } else {
        normalize_memory_type(&meta.memory_type)
    }
}
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| Duration::from_secs(0))
        .as_millis() as i64
}

fn system_time_to_ms(value: SystemTime) -> Option<i64> {
    value
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis() as i64)
}

fn format_rfc3339(ms: i64) -> String {
    let seconds = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000) as u32;
    Utc.timestamp_opt(seconds, millis * 1_000_000)
        .single()
        .unwrap_or_else(Utc::now)
        .to_rfc3339()
}

fn parse_rfc3339_ms(input: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(input)
        .ok()
        .map(|value| value.timestamp_millis())
}
