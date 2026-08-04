impl MemoryStore {
    fn collect_memory_files(&self) -> Result<Vec<ParsedMemoryFile>, String> {
        let mut out = Vec::new();
        collect_md_files(&self.global_dir(), false, &mut out)?;
        collect_md_files(&self.global_user_dir(), false, &mut out)?;
        collect_md_files(&self.global_daily_dir(), false, &mut out)?;
        let projects = self.projects_dir();
        if projects.exists() {
            for entry in
                fs::read_dir(&projects).map_err(|e| format!("读取项目记忆目录失败：{e}"))?
            {
                let entry = entry.map_err(|e| format!("读取项目记忆目录项失败：{e}"))?;
                if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    collect_md_files(&entry.path(), false, &mut out)?;
                }
            }
        }
        Ok(out)
    }

    fn enrich_project_paths(&self, rows: &mut [MemoryMeta]) {
        let mut cache: HashMap<String, Option<String>> = HashMap::new();
        for entry in rows {
            if entry.scope != "project" || entry.workdir_hash.is_empty() {
                continue;
            }
            let path = cache
                .entry(entry.workdir_hash.clone())
                .or_insert_with(|| self.project_workdir_path(&entry.workdir_hash))
                .clone();
            entry.workdir_path = path;
        }
    }

    fn project_workdir_path(&self, workdir_hash: &str) -> Option<String> {
        let marker = self.projects_dir().join(workdir_hash).join(".workdir.json");
        let bytes = fs::read(marker).ok()?;
        let value = serde_json::from_slice::<Value>(&bytes).ok()?;
        value
            .get("path")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .map(ToString::to_string)
    }

    fn refresh_memory_indexes(&self) -> Result<(), String> {
        let conn = self.lock_conn()?;
        let rows = load_all_meta(&conn)?;
        drop(conn);
        render_scope_index(
            &self.global_dir(),
            rows.iter().filter(|entry| entry.scope == "global"),
        )?;
        let mut project_rows: BTreeMap<String, Vec<&MemoryMeta>> = BTreeMap::new();
        for entry in &rows {
            if entry.scope == "project" {
                project_rows
                    .entry(entry.workdir_hash.clone())
                    .or_default()
                    .push(entry);
            }
        }
        for (hash, entries) in project_rows {
            render_scope_index(&self.projects_dir().join(hash), entries.into_iter())?;
        }
        Ok(())
    }

    fn atomic_replace_entry_file(&self, target: &Path, content: &str) -> Result<(), String> {
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建记忆目录失败：{e}"))?;
        }
        atomic_write(target, content.as_bytes())
    }

    fn path_for(
        &self,
        scope: &str,
        workdir_hash: &str,
        workdir: Option<&str>,
        memory_type: &str,
        slug: &str,
    ) -> Result<PathBuf, String> {
        if memory_type == "daily" {
            let date = slug.trim_start_matches("daily-");
            return Ok(self.global_daily_dir().join(format!("{date}.md")));
        }
        if scope == "global" {
            if matches!(memory_type, "user" | "feedback") {
                return Ok(self.global_user_dir().join(format!("{slug}.md")));
            }
            return Ok(self.global_dir().join(format!("{slug}.md")));
        }
        if workdir_hash.is_empty() {
            return Err("project memory requires workdir hash".to_string());
        }
        let dir = self.projects_dir().join(workdir_hash);
        fs::create_dir_all(&dir).map_err(|e| format!("创建项目记忆目录失败：{e}"))?;
        if let Some(workdir) = workdir {
            let marker = dir.join(".workdir.json");
            if !marker.exists() {
                let payload = serde_json::to_vec_pretty(&json!({
                    "path": workdir,
                    "createdAt": format_rfc3339(now_ms())
                }))
                .map_err(|e| format!("序列化项目记忆标记失败：{e}"))?;
                atomic_write(&marker, &payload)?;
            }
        }
        Ok(dir.join(format!("{slug}.md")))
    }

    fn path_for_meta(&self, meta: &MemoryMeta) -> Result<PathBuf, String> {
        if meta.archived && meta.memory_type == "daily" {
            let date = meta
                .date_local
                .as_deref()
                .unwrap_or_else(|| meta.slug.trim_start_matches("daily-"));
            let year = NaiveDate::parse_from_str(date, "%Y-%m-%d")
                .map(|date| date.year().to_string())
                .unwrap_or_else(|_| date.chars().take(4).collect::<String>());
            let archive_dir = self.global_daily_dir().join(".archive").join(year);
            let canonical = archive_dir.join(format!("{date}.md"));
            if canonical.exists() {
                return Ok(canonical);
            }
            let legacy = archive_dir.join(format!("{}.md", meta.slug));
            if legacy.exists() {
                return Ok(legacy);
            }
            return Ok(canonical);
        }
        self.path_for(
            &meta.scope,
            &meta.workdir_hash,
            None,
            &meta.memory_type,
            &meta.slug,
        )
    }

    fn trash_dir_for(&self, meta: &MemoryMeta) -> Result<PathBuf, String> {
        if meta.scope == "global" {
            Ok(self.global_dir().join(".trash"))
        } else {
            Ok(self.projects_dir().join(&meta.workdir_hash).join(".trash"))
        }
    }

    fn organize_snapshot_dir_for(&self, meta: &MemoryMeta) -> PathBuf {
        if meta.scope == "global" {
            self.global_dir().join(".organize-snapshots")
        } else {
            self.projects_dir()
                .join(&meta.workdir_hash)
                .join(".organize-snapshots")
        }
    }

    fn snapshot_entry_before_organize(&self, meta: &MemoryMeta, path: &Path) -> Result<(), String> {
        if !path.exists() {
            return Ok(());
        }
        let dir = self.organize_snapshot_dir_for(meta);
        fs::create_dir_all(&dir).map_err(|e| format!("创建记忆整理快照目录失败：{e}"))?;
        let snapshot = dir.join(format!("{}.{}.md", now_ms(), meta.slug));
        fs::copy(path, snapshot).map_err(|e| format!("写入记忆整理快照失败：{e}"))?;
        Ok(())
    }

    fn global_dir(&self) -> PathBuf {
        self.root.join("global")
    }

    fn global_user_dir(&self) -> PathBuf {
        self.global_dir().join("user")
    }

    fn global_daily_dir(&self) -> PathBuf {
        self.global_dir().join("daily")
    }

    fn projects_dir(&self) -> PathBuf {
        self.root.join("projects")
    }

    fn lock_conn(&self) -> Result<std::sync::MutexGuard<'_, Connection>, String> {
        match self.conn.lock() {
            Ok(guard) => Ok(guard),
            Err(poisoned) => {
                eprintln!("memory sqlite mutex was poisoned; recovering existing connection");
                let guard = poisoned.into_inner();
                self.conn.clear_poison();
                Ok(guard)
            }
        }
    }

    fn lock_mutation(&self) -> Result<std::sync::MutexGuard<'_, ()>, String> {
        match self.mutation_lock.lock() {
            Ok(guard) => Ok(guard),
            Err(poisoned) => {
                eprintln!("memory mutation mutex was poisoned; continuing with recovered lock");
                let guard = poisoned.into_inner();
                self.mutation_lock.clear_poison();
                Ok(guard)
            }
        }
    }

}

fn collect_organize_snapshot_dirs(root: &Path) -> Vec<PathBuf> {
    let mut dirs = vec![root.join("global").join(".organize-snapshots")];
    let projects_dir = root.join("projects");
    if let Ok(entries) = fs::read_dir(projects_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                dirs.push(path.join(".organize-snapshots"));
            }
        }
    }
    dirs
}

fn memory_root_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "无法定位用户目录".to_string())?;
    Ok(home.join(MEMORY_DIR_NAME).join(MEMORY_ROOT_DIR))
}

fn ensure_root_dirs(root: &Path) -> Result<(), String> {
    for dir in [
        root.to_path_buf(),
        root.join("global"),
        root.join("global").join("user"),
        root.join("global").join("daily"),
        root.join("projects"),
        root.join(".quarantine"),
    ] {
        fs::create_dir_all(&dir)
            .map_err(|e| format!("创建记忆目录 {} 失败：{e}", dir.display()))?;
    }
    Ok(())
}
fn collect_md_files(
    dir: &Path,
    archived: bool,
    out: &mut Vec<ParsedMemoryFile>,
) -> Result<(), String> {
    if !dir.exists() {
        return Ok(());
    }
    for entry in
        fs::read_dir(dir).map_err(|e| format!("读取记忆目录 {} 失败：{e}", dir.display()))?
    {
        let entry = entry.map_err(|e| format!("读取记忆目录项失败：{e}"))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|e| format!("读取记忆文件类型失败：{e}"))?;
        if file_type.is_dir() {
            let name = entry.file_name().to_string_lossy().to_string();
            if archived || name == ".archive" {
                collect_md_files(&path, archived || name == ".archive", out)?;
            }
            continue;
        }
        if path.file_name().and_then(|name| name.to_str()) == Some("MEMORY.md") {
            continue;
        }
        if path.extension().and_then(|ext| ext.to_str()) != Some("md") {
            continue;
        }
        match parse_memory_file(&path, archived) {
            Ok(parsed) => out.push(parsed),
            Err(error) => eprintln!("failed to parse memory file {}: {error}", path.display()),
        }
    }
    Ok(())
}
fn optional_workdir_hash(workdir: Option<&str>) -> Result<Option<String>, String> {
    workdir
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(workdir_hash)
        .transpose()
}

fn normalize_workdir_hash_input(workdir_hash: Option<&str>) -> Result<Option<String>, String> {
    let Some(hash) = workdir_hash
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    let valid = hash.len() == 16 && hash.bytes().all(|byte| byte.is_ascii_hexdigit());
    if !valid {
        return Err(error_json(
            "invalid_workdir_hash",
            "workdirHash must be a 16-character hex project id",
            None,
            None,
        ));
    }
    Ok(Some(hash.to_ascii_lowercase()))
}

fn required_workdir_hash(workdir: Option<&str>) -> Result<String, String> {
    let workdir = workdir
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            error_json(
                "workdir_required",
                "project memory requires a workdir",
                None,
                None,
            )
        })?;
    workdir_hash(workdir)
}

fn workdir_hash(workdir: &str) -> Result<String, String> {
    let path = fs::canonicalize(workdir).unwrap_or_else(|_| PathBuf::from(workdir));
    let normalized = path.to_string_lossy();
    let digest = Sha256::digest(normalized.as_bytes());
    Ok(to_hex(&digest)[..16].to_string())
}

fn workdir_paths_match(left: &str, right: &str) -> bool {
    let left = left.trim();
    let right = right.trim();
    if left.is_empty() || right.is_empty() {
        return false;
    }
    if left == right {
        return true;
    }
    match (fs::canonicalize(left), fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    to_hex(&digest)
}

fn to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}
fn atomic_write(target: &Path, content: &[u8]) -> Result<(), String> {
    let parent = target
        .parent()
        .ok_or_else(|| format!("目标路径没有父目录：{}", target.display()))?;
    fs::create_dir_all(parent).map_err(|e| format!("创建目录 {} 失败：{e}", parent.display()))?;
    let mut tmp = tempfile::NamedTempFile::new_in(parent)
        .map_err(|e| format!("创建临时记忆文件失败：{e}"))?;
    tmp.write_all(content)
        .map_err(|e| format!("写入临时记忆文件失败：{e}"))?;
    tmp.as_file()
        .sync_all()
        .map_err(|e| format!("fsync 临时记忆文件失败：{e}"))?;
    tmp.persist(target)
        .map_err(|e| format!("替换记忆文件失败：{}", e.error))?;
    if let Ok(parent_file) = File::open(parent) {
        let _ = parent_file.sync_all();
    }
    Ok(())
}
