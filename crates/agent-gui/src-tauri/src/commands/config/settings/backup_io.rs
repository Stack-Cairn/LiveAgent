// 配置备份的本地导入/导出命令。
//
// 文件对话框走 rfd（与 system_pick_file 同一范式），不引入
// tauri-plugin-dialog / plugin-fs —— 仓库未安装这两个插件。
//
// 导出与写入在同一个命令内完成（用户选路径后立即落盘），因此不需要
// system_prepare_preview_file_save_sync 那种一次性 save_token 机制。

/// 导出：弹保存对话框并写入文件。用户取消返回 None。
///
/// skills 由前端从 localStorage 读出后传入 —— 该数据后端不可见。
#[tauri::command]
pub async fn settings_backup_export(skills: Option<Value>) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_db()?;
        let snapshot = collect_backup_snapshot(&conn, skills)?;
        let manifest = build_backup_manifest(&snapshot);
        let document = serialize_backup_document(&snapshot, &manifest)?;

        let default_name = format!("liveagent-config-{}.json", now_ms());
        let Some(target) = rfd::FileDialog::new()
            .set_file_name(&default_name)
            .add_filter("LiveAgent 配置", &["json"])
            .save_file()
        else {
            return Ok(None);
        };

        fs::write(&target, document).map_err(|e| format!("写入备份文件失败：{e}"))?;
        Ok(Some(target.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|e| format!("settings_backup_export join 失败：{e}"))?
}

/// 导入预检：选文件 → 解析 → 校验，但**不写库**。
///
/// 拆成 peek/apply 两步是为了让用户在覆盖本地配置前看到来源摘要并确认。
/// path 为空时弹选择对话框；用户取消返回 None。
#[tauri::command]
pub async fn settings_backup_peek_import(
    path: Option<String>,
) -> Result<Option<BackupImportPreview>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let target = match path {
            Some(value) => PathBuf::from(value),
            None => {
                let Some(picked) = rfd::FileDialog::new()
                    .add_filter("LiveAgent 配置", &["json"])
                    .pick_file()
                else {
                    return Ok(None);
                };
                picked
            }
        };

        let raw = read_backup_file(&target)?;
        let (_, manifest) = parse_backup_document(&raw)?;
        Ok(Some(BackupImportPreview {
            path: target.to_string_lossy().into_owned(),
            manifest,
        }))
    })
    .await
    .map_err(|e| format!("settings_backup_peek_import join 失败：{e}"))?
}

/// 导入应用：真正写库。写入前自动备份当前配置。
///
/// 返回的 skills 由前端写回 localStorage。
///
/// **与 WebDAV 共用全局锁。** 导入同样跨 providers/mcp/system 三域分别写库，
/// 中间态不自洽；不加锁的话一次自动上传可以正好在写到一半时采集快照，把
/// 半旧半新的配置推上远端，而它会带着自洽的 sha256 通过下载侧所有校验。
/// 与 `upload_backup_snapshot` 里把锁提到采集之前所堵的是同一个窗口。
///
/// 抑制守卫则**有意不加**：导入是用户明确要求把这份配置变成当前配置，
/// 随后自动同步上去正是预期行为（与 WebDAV 下载相反 —— 那边数据本就来自
/// 远端，推回去纯属回声）。
#[tauri::command]
pub async fn settings_backup_apply_import(path: String) -> Result<BackupApplyOutcome, String> {
    let _guard = backup_sync_mutex().lock().await;
    tauri::async_runtime::spawn_blocking(move || {
        let target = PathBuf::from(path);
        let raw = read_backup_file(&target)?;
        let (snapshot, _) = parse_backup_document(&raw)?;
        let mut conn = open_db()?;
        apply_backup_snapshot(&mut conn, snapshot)
    })
    .await
    .map_err(|e| format!("settings_backup_apply_import join 失败：{e}"))?
}
