//! 配置自动同步：把连续的配置变更合并成一次 WebDAV 上传。
//!
//! **只上传，不下载。** 自动拉取远端会在用户毫无察觉的情况下覆盖本机配置，
//! 出错方向不可接受，因此拉取永远是手动动作。

use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Mutex, OnceLock,
};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::{sync::mpsc, time::Duration};

/// 变更后等待这么久没有新变更才上传。
const DEBOUNCE: Duration = Duration::from_secs(1);
/// 防抖的硬上限。持续编辑（例如逐字输入 API Key）会不断刷新防抖窗口，
/// 没有上限的话可以无限推迟上传。
const MAX_WAIT: Duration = Duration::from_secs(10);

/// 自动同步结果事件。手动同步的成败由命令的返回值同步告知前端，
/// 不走这个事件 —— 所以收到事件就意味着「后台自动同步」。
const STATUS_EVENT: &str = "backup-sync-status-updated";

static DIRTY_TX: OnceLock<mpsc::Sender<()>> = OnceLock::new();
static SUPPRESSION: AtomicUsize = AtomicUsize::new(0);
static CACHED_SKILLS: OnceLock<Mutex<Option<Value>>> = OnceLock::new();

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AutoSyncStatus {
    /// 毫秒时间戳，仅成功时有值。
    last_sync_at: Option<i64>,
    last_error: Option<String>,
}

fn skills_cache() -> &'static Mutex<Option<Value>> {
    CACHED_SKILLS.get_or_init(|| Mutex::new(None))
}

/// 抑制期计数器的 RAII 句柄。
pub struct AutoSyncSuppressionGuard;

impl Drop for AutoSyncSuppressionGuard {
    fn drop(&mut self) {
        SUPPRESSION.fetch_sub(1, Ordering::SeqCst);
    }
}

/// 下载并应用远端快照期间必须持有。
///
/// 应用快照走的是 `save_providers` / `save_mcp` / `save_system`，它们会标脏；
/// 不抑制就会把刚从远端拉下来的数据原样推回去。
pub fn suppress() -> AutoSyncSuppressionGuard {
    SUPPRESSION.fetch_add(1, Ordering::SeqCst);
    AutoSyncSuppressionGuard
}

/// 标记配置已变更。未启动自动同步任务时为空操作（单测环境即如此）。
pub fn mark_dirty() {
    if suppressed() {
        return;
    }
    if let Some(tx) = DIRTY_TX.get() {
        // 容量 1：已有未处理的脏信号时直接丢弃，防抖窗口本就会把它们合并成一次上传。
        let _ = tx.try_send(());
    }
}

fn suppressed() -> bool {
    SUPPRESSION.load(Ordering::SeqCst) > 0
}

/// 记录前端最近一次的技能启用态。
///
/// 技能启用态存在 webview localStorage，后端读不到；自动上传没有前端参与，
/// 只能用这份缓存。缓存为空时上传会省略 skills 域，而不是写入空值 ——
/// 省略在下载侧表现为「不动本机技能设置」，写空值会把它们全部清掉。
pub fn cache_skills(skills: Option<Value>) {
    if let Ok(mut slot) = skills_cache().lock() {
        *slot = skills;
    }
}

fn cached_skills() -> Option<Value> {
    skills_cache().lock().ok().and_then(|slot| slot.clone())
}

pub fn start(app: AppHandle) {
    let (tx, rx) = mpsc::channel(1);
    if DIRTY_TX.set(tx).is_err() {
        return;
    }
    tauri::async_runtime::spawn(run(app, rx));
}

async fn run(app: AppHandle, mut rx: mpsc::Receiver<()>) {
    loop {
        // 空闲时阻塞在这里，第一个脏信号开启一个防抖窗口。
        if rx.recv().await.is_none() {
            return;
        }

        let cap = tokio::time::sleep(MAX_WAIT);
        tokio::pin!(cap);
        loop {
            tokio::select! {
                // 静默满 DEBOUNCE：窗口内的所有变更合并成下面这一次上传。
                _ = tokio::time::sleep(DEBOUNCE) => break,
                // 一直有新变更时也不能无限等。
                _ = &mut cap => break,
                signal = rx.recv() => {
                    if signal.is_none() {
                        return;
                    }
                }
            }
        }

        sync_once(&app).await;
    }
}

async fn sync_once(app: &AppHandle) {
    // 防抖期间用户可能开始了手动下载，这里再确认一次。
    if suppressed() {
        return;
    }

    match crate::commands::settings::auto_upload_backup_snapshot(cached_skills()).await {
        // 未开启自动同步或凭据不全，静默跳过，不打扰用户。
        Ok(None) => {}
        Ok(Some(last_sync_at)) => emit_status(
            app,
            AutoSyncStatus {
                last_sync_at: Some(last_sync_at),
                last_error: None,
            },
        ),
        // 自动同步失败不能阻塞任何操作，只推事件让 UI 显示横幅。
        Err(error) => emit_status(
            app,
            AutoSyncStatus {
                last_sync_at: None,
                last_error: Some(error),
            },
        ),
    }
}

fn emit_status(app: &AppHandle, status: AutoSyncStatus) {
    if let Err(error) = app.emit(STATUS_EVENT, status) {
        eprintln!("failed to emit backup sync status: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 抑制的进入/嵌套/退出合并成一个用例：`SUPPRESSION` 是进程级全局，
    /// 拆成多个用例会在并行测试下互相踩踏。
    #[test]
    fn suppression_is_reference_counted_and_gates_dirty_marks() {
        assert!(!suppressed(), "初始状态不应处于抑制期");

        let outer = suppress();
        assert!(suppressed());
        // 抑制期内标脏必须无效，否则应用远端快照会立刻把数据推回远端。
        mark_dirty();

        {
            let _inner = suppress();
            assert!(suppressed());
        }
        // 内层释放不能提前解除外层的抑制。
        assert!(suppressed(), "仍有外层 guard 存活时必须保持抑制");

        drop(outer);
        assert!(!suppressed(), "全部 guard 释放后应恢复标脏");
    }

    /// 容量 1 的 channel 把窗口内的多次变更压成一个信号 —— 这是防抖合并的基础。
    #[test]
    fn dirty_channel_coalesces_bursts_into_one_signal() {
        let (tx, mut rx) = mpsc::channel::<()>(1);
        for _ in 0..5 {
            let _ = tx.try_send(());
        }
        assert!(rx.try_recv().is_ok());
        assert!(rx.try_recv().is_err(), "5 次变更只应留下 1 个待处理信号");
    }

    /// 清空缓存必须回到 None（上传时省略 skills 域），不能退化成写入空值。
    #[test]
    fn skills_cache_round_trips_and_clears_to_none() {
        cache_skills(Some(serde_json::json!({ "enabled": ["a"] })));
        assert_eq!(
            cached_skills(),
            Some(serde_json::json!({ "enabled": ["a"] }))
        );
        cache_skills(None);
        assert!(cached_skills().is_none());
    }
}
