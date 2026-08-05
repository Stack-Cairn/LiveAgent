//! 隧道命令。名字从 `gateway_tunnel_*` 改为 `tunnel_*`——新架构里没有 gateway。
//!
//! 五个命令都很薄:参数校验和状态变更在 `services::tunnel::store`,
//! 这里只做「命令 → store 调用」的转发,外加 check 的异步探活编排。

use std::sync::Arc;

use crate::services::tunnel::{
    probe, TunnelCreateInput, TunnelError, TunnelState, TunnelStore, TunnelUpdateInput,
};

/// 当前隧道快照。
pub fn tunnel_state(store: &Arc<TunnelStore>) -> Result<TunnelState, String> {
    store.state()
}

/// 建隧道。成功后立刻探一次活,让面板不用等 15s 节流窗口就有健康状态。
pub async fn tunnel_create(
    input: TunnelCreateInput,
    store: &Arc<TunnelStore>,
) -> Result<(), TunnelError> {
    let id = store.create(input).await?;
    spawn_probe(store, Some(vec![id]));
    Ok(())
}

/// 改隧道。
pub async fn tunnel_update(
    input: TunnelUpdateInput,
    store: &Arc<TunnelStore>,
) -> Result<(), TunnelError> {
    let id = store.update(input).await?;
    spawn_probe(store, Some(vec![id]));
    Ok(())
}

/// 关隧道。
pub async fn tunnel_close(
    tunnel_id: String,
    store: &Arc<TunnelStore>,
) -> Result<(), TunnelError> {
    store.close(tunnel_id).await?;
    Ok(())
}

/// 触发探活。`tunnel_id` 为 None 表示探全部。
///
/// 显式 check 绕过节流(用户点了「检查」就该真去检查),且**同步等待**结果——
/// 旧实现是异步的,前端只能靠 sleep 2.5s 再拉快照来碰运气。同步返回后快照
/// 一定是新的,那个 sleep 可以删掉。
pub async fn tunnel_check(
    tunnel_id: Option<String>,
    store: &Arc<TunnelStore>,
) -> Result<(), TunnelError> {
    let tunnel_id = tunnel_id
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty());
    if let Some(id) = tunnel_id.as_ref() {
        if !store.exists(id).map_err(TunnelError::internal)? {
            return Err(TunnelError::not_found());
        }
    }
    probe::run_probes(store, tunnel_id.map(|id| vec![id]), true).await;
    Ok(())
}

/// 后台探活:不阻塞变更命令的返回。
fn spawn_probe(store: &Arc<TunnelStore>, tunnel_ids: Option<Vec<String>>) {
    let store = Arc::clone(store);
    tokio::spawn(async move {
        probe::run_probes(&store, tunnel_ids, true).await;
    });
}
