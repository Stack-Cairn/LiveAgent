impl MemoryStore {
    pub fn overview(&self, workdir: Option<String>) -> Result<MemoryOverviewResponse, String> {
        let workdir_hash = optional_workdir_hash(workdir.as_deref())?;
        let conn = self.lock_conn()?;
        let mut rows = load_all_meta(&conn)?;
        rows.sort_by(|a, b| {
            b.updated_at
                .cmp(&a.updated_at)
                .then_with(|| a.slug.cmp(&b.slug))
        });

        let project_slugs = rows
            .iter()
            .filter(|entry| {
                entry.scope == "project"
                    && workdir_hash
                        .as_deref()
                        .is_some_and(|hash| entry.workdir_hash == hash)
                    && entry.memory_type != "daily"
            })
            .map(|entry| entry.slug.clone())
            .collect::<HashSet<_>>();

        let user = rows
            .iter()
            .filter(|entry| {
                entry.scope == "global"
                    && (entry.memory_type == "user"
                        || (entry.memory_type == "feedback" && !entry.unreviewed))
            })
            .take(80)
            .map(overview_entry)
            .collect();

        let project = rows
            .iter()
            .filter(|entry| {
                entry.scope == "project"
                    && workdir_hash
                        .as_deref()
                        .is_some_and(|hash| entry.workdir_hash == hash)
                    && entry.memory_type != "daily"
            })
            .take(80)
            .map(overview_entry)
            .collect();

        let global = rows
            .iter()
            .filter(|entry| {
                entry.scope == "global"
                    && entry.memory_type != "daily"
                    && !matches!(entry.memory_type.as_str(), "user" | "feedback")
                    && !project_slugs.contains(&entry.slug)
            })
            .take(80)
            .map(overview_entry)
            .collect();

        let mut recent_days = rows
            .iter()
            .filter(|entry| entry.memory_type == "daily" && !entry.archived)
            .map(overview_entry)
            .collect::<Vec<_>>();
        recent_days.sort_by(|a, b| b.date_local.cmp(&a.date_local));
        recent_days.truncate(RECENT_DAYS_LIMIT);

        Ok(MemoryOverviewResponse {
            user,
            project,
            global,
            recent_days,
            root: self.root.to_string_lossy().to_string(),
            workdir_hash,
        })
    }

    pub fn paths_info(&self) -> Result<MemoryPathsInfo, String> {
        let conn = self.lock_conn()?;
        let used = count_non_daily_entries(&conn, None)?;
        let daily_count = conn
            .query_row(
                "SELECT COUNT(*) FROM memory_meta WHERE type = 'daily'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|e| format!("读取记忆状态失败：{e}"))?;
        let (is_in_cloud, cloud_provider) = detect_sync_root(&self.root);
        Ok(MemoryPathsInfo {
            root: self.root.to_string_lossy().to_string(),
            is_fresh: used == 0 && daily_count == 0,
            is_in_cloud,
            cloud_provider,
        })
    }

    pub fn recent_rejections(
        &self,
        args: MemoryRecentRejectionsArgs,
    ) -> Result<MemoryRecentRejectionsResponse, String> {
        let since_days = args.since_days.unwrap_or(7).clamp(1, 365);
        let limit = args.limit.unwrap_or(30).clamp(1, 200);
        let workdir_hash = optional_workdir_hash(args.workdir.as_deref())?;
        let cutoff_ms = now_ms() - (since_days as i64) * 86_400_000;
        let conn = self.lock_conn()?;
        let map_row = |row: &rusqlite::Row<'_>| {
            let slug: String = row.get(0)?;
            let scope: String = row.get(1)?;
            let workdir_hash: String = row.get(2)?;
            let rejected_at: i64 = row.get(3)?;
            let actor: String = row.get(4)?;
            let detail_json: Option<String> = row.get(5)?;
            let reason = detail_json
                .as_deref()
                .and_then(|s| serde_json::from_str::<Value>(s).ok())
                .and_then(|value| {
                    value
                        .get("reason")
                        .and_then(|v| v.as_str().map(|s| s.to_string()))
                });
            Ok(MemoryRejectionEntry {
                slug,
                scope,
                workdir_hash,
                rejected_at,
                actor,
                reason,
            })
        };
        let mut stmt = if workdir_hash.is_some() {
            conn.prepare(
                "
                SELECT slug, scope, workdir_hash, ts, actor, detail_json
                FROM memory_audit_log
                WHERE op = 'delete'
                  AND actor = 'user'
                  AND ts >= ?1
                  AND (scope = 'global' OR (scope = 'project' AND workdir_hash = ?2))
                ORDER BY ts DESC
                LIMIT ?3
                ",
            )
        } else {
            conn.prepare(
                "
                SELECT slug, scope, workdir_hash, ts, actor, detail_json
                FROM memory_audit_log
                WHERE op = 'delete'
                  AND actor = 'user'
                  AND ts >= ?1
                  AND scope = 'global'
                ORDER BY ts DESC
                LIMIT ?2
                ",
            )
        }
        .map_err(|e| format!("准备记忆拒绝日志查询失败：{e}"))?;
        let rows = if let Some(hash) = workdir_hash.as_deref() {
            stmt.query_map(params![cutoff_ms, hash, limit as i64], map_row)
        } else {
            stmt.query_map(params![cutoff_ms, limit as i64], map_row)
        }
        .map_err(|e| format!("读取记忆拒绝日志失败：{e}"))?;

        // De-duplicate by slug, keeping the most recent rejection. Audit log
        // may record the same slug being deleted multiple times across a user
        // session; the silent-memory prompt only needs the latest one.
        let mut seen_entries = std::collections::HashSet::new();
        let mut entries = Vec::new();
        for row in rows {
            let entry = row.map_err(|e| format!("读取记忆拒绝行失败：{e}"))?;
            let key = (
                entry.scope.clone(),
                entry.workdir_hash.clone(),
                entry.slug.clone(),
            );
            if seen_entries.insert(key) {
                entries.push(entry);
            }
        }
        Ok(MemoryRecentRejectionsResponse { entries })
    }


}

impl MemoryStore {
    pub fn wipe_all(&self) -> Result<MemoryPathsInfo, String> {
        let _mutation_guard = self.lock_mutation()?;
        let quarantine = self
            .root
            .join(".quarantine")
            .join(format!("wiped-{}", now_ms()));
        fs::create_dir_all(&quarantine).map_err(|e| format!("创建记忆备份目录失败：{e}"))?;
        for name in ["global", "projects", DB_FILENAME] {
            let src = self.root.join(name);
            if src.exists() {
                let dst = quarantine.join(name);
                fs::rename(&src, &dst).map_err(|e| format!("备份记忆 {name} 失败：{e}"))?;
            }
        }
        ensure_root_dirs(&self.root)?;
        {
            let mut conn = self.lock_conn()?;
            *conn = open_memory_connection(&self.db_path)?;
        }
        self.reconcile()?;
        self.paths_info()
    }


}

impl MemoryStore {
    fn reconcile(&self) -> Result<(), String> {
        self.archive_old_dailies(DEFAULT_DAILY_RETENTION_DAYS)?;
        let mut conn = self.lock_conn()?;
        conn.execute_batch(
            "DELETE FROM memory_meta; DELETE FROM memory_fts; DELETE FROM memory_fts_tri;",
        )
        .map_err(|e| format!("清空记忆索引失败：{e}"))?;
        let files = self.collect_memory_files()?;
        for parsed in files {
            if let Err(error) = index_parsed_file(&mut conn, &parsed, &parsed.path, parsed.archived)
            {
                eprintln!(
                    "failed to index memory file {}: {error}",
                    parsed.path.display()
                );
            }
        }
        drop(conn);
        self.refresh_memory_indexes()
    }

    fn archive_old_dailies(&self, retention_days: i64) -> Result<(), String> {
        let daily_dir = self.global_daily_dir();
        if !daily_dir.exists() {
            return Ok(());
        }
        let today = Local::now().date_naive();
        let entries = fs::read_dir(&daily_dir).map_err(|e| format!("读取 daily 目录失败：{e}"))?;
        for entry in entries {
            let entry = entry.map_err(|e| format!("读取 daily 文件失败：{e}"))?;
            let path = entry.path();
            if !path.is_file() || path.extension().and_then(|value| value.to_str()) != Some("md") {
                continue;
            }
            let parsed = match parse_memory_file(&path, false) {
                Ok(parsed) => parsed,
                Err(error) => {
                    eprintln!("failed to parse daily memory {}: {error}", path.display());
                    continue;
                }
            };
            if parsed.meta.memory_type != "daily" {
                continue;
            }
            let Some(date_text) = parsed
                .meta
                .date
                .as_deref()
                .or_else(|| path.file_stem().and_then(|value| value.to_str()))
            else {
                continue;
            };
            let Ok(date) = NaiveDate::parse_from_str(date_text, "%Y-%m-%d") else {
                continue;
            };
            if today.signed_duration_since(date).num_days() <= retention_days {
                continue;
            }
            let archive_dir = daily_dir.join(".archive").join(format!("{}", date.year()));
            fs::create_dir_all(&archive_dir)
                .map_err(|e| format!("创建 daily 归档目录失败：{e}"))?;
            let target = archive_dir.join(
                path.file_name()
                    .ok_or_else(|| "daily file has no file name".to_string())?,
            );
            if target.exists() {
                eprintln!(
                    "daily archive target already exists, leaving hot file in place: {}",
                    target.display()
                );
                continue;
            }
            fs::rename(&path, &target).map_err(|e| {
                format!(
                    "归档 daily 记忆 {} -> {} 失败：{e}",
                    path.display(),
                    target.display()
                )
            })?;
        }
        Ok(())
    }


}

impl MemoryStore {
    fn gc_old_wipe_backups(&self) -> Result<(), String> {
        let dir = self.root.join(".quarantine");
        if !dir.exists() {
            return Ok(());
        }
        let cutoff = now_ms() - 7 * 24 * 60 * 60 * 1000;
        for entry in fs::read_dir(&dir).map_err(|e| format!("读取记忆隔离目录失败：{e}"))?
        {
            let entry = entry.map_err(|e| format!("读取记忆隔离目录项失败：{e}"))?;
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.starts_with("wiped-") {
                continue;
            }
            let ts = name
                .trim_start_matches("wiped-")
                .parse::<i64>()
                .unwrap_or(now_ms());
            if ts < cutoff {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
        Ok(())
    }

    fn gc_old_organize_snapshots(&self) -> Result<(), String> {
        let cutoff = now_ms() - 30 * 24 * 60 * 60 * 1000;
        for dir in collect_organize_snapshot_dirs(&self.root) {
            if !dir.exists() {
                continue;
            }
            for entry in fs::read_dir(&dir).map_err(|e| format!("读取记忆整理快照目录失败：{e}"))?
            {
                let entry = entry.map_err(|e| format!("读取记忆整理快照目录项失败：{e}"))?;
                let name = entry.file_name().to_string_lossy().to_string();
                let ts = name
                    .split('.')
                    .next()
                    .and_then(|value| value.parse::<i64>().ok())
                    .unwrap_or(now_ms());
                if ts < cutoff {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
        Ok(())
    }

}

fn render_scope_index<'a>(
    dir: &Path,
    entries: impl Iterator<Item = &'a MemoryMeta>,
) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("创建 MEMORY.md 目录失败：{e}"))?;
    let mut rows = entries
        .filter(|entry| entry.memory_type != "daily")
        .cloned()
        .collect::<Vec<_>>();
    rows.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then_with(|| a.slug.cmp(&b.slug))
    });
    let mut lines = vec![
        "# MEMORY",
        "",
        "This file is auto-generated by LiveAgent. Edit individual memory Markdown files instead.",
        "",
    ]
    .into_iter()
    .map(String::from)
    .collect::<Vec<_>>();
    for entry in rows {
        let marker = if entry.unreviewed {
            " (unreviewed)"
        } else {
            ""
        };
        lines.push(format!(
            "- [{}] type={}{} — {}",
            entry.slug, entry.memory_type, marker, entry.description
        ));
    }
    lines.push(String::new());
    atomic_write(&dir.join("MEMORY.md"), lines.join("\n").as_bytes())
}

fn overview_entry(entry: &MemoryMeta) -> MemoryOverviewEntry {
    MemoryOverviewEntry {
        slug: entry.slug.clone(),
        scope: entry.scope.clone(),
        memory_type: entry.memory_type.clone(),
        description: entry.description.clone(),
        headline: entry.headline.clone(),
        date_local: entry.date_local.clone(),
        updated_at: entry.updated_at,
        unreviewed: entry.unreviewed,
        confidence: entry.confidence.clone(),
    }
}

fn fuzzy_candidates(conn: &Connection, slug: &str) -> Result<Vec<Value>, String> {
    let pattern = format!("%{}%", slug.replace('-', "%"));
    let mut stmt = conn
        .prepare(
            "SELECT slug, scope FROM memory_meta WHERE slug LIKE ?1 ORDER BY updated_at DESC LIMIT 3",
        )
        .map_err(|e| format!("准备记忆候选查询失败：{e}"))?;
    let rows = stmt
        .query_map(params![pattern], |row| {
            Ok(json!({
                "slug": row.get::<_, String>(0)?,
                "scope": row.get::<_, String>(1)?
            }))
        })
        .map_err(|e| format!("查询记忆候选失败：{e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取记忆候选失败：{e}"))
}

fn detect_sync_root(path: &Path) -> (bool, Option<String>) {
    let text = path.to_string_lossy().to_lowercase();
    for (needle, provider) in [
        ("mobile documents", "iCloud"),
        ("icloud", "iCloud"),
        ("dropbox", "Dropbox"),
        ("onedrive", "OneDrive"),
        ("google drive", "Google Drive"),
    ] {
        if text.contains(needle) {
            return (true, Some(provider.to_string()));
        }
    }
    (false, None)
}
