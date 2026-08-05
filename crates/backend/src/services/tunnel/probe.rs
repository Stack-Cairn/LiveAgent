//! 隧道目标探活。
//!
//! 只做一件事:对目标发一个 GET,记录状态码和耗时。放在 backend 而不是
//! 数据面里,是因为探活的**结果**属于隧道状态(要进快照发给前端),而它不需要
//! 任何 HTTP 服务器能力——reqwest 就够了。

use std::sync::Arc;
use std::time::{Duration, Instant};

use super::store::{now_unix_seconds, TunnelStore};
use super::TunnelHealth;

/// 单次探活的超时。本机服务不该比这更慢,慢了就是有问题,该报出来。
const PROBE_TIMEOUT: Duration = Duration::from_secs(2);

/// 探一批目标并把结果写回 store(store 随即广播新快照)。
///
/// `tunnel_ids` 为 `None` 表示探全部。`bypass_throttle` 供用户显式点「检查」时用。
pub async fn run_probes(
    store: &Arc<TunnelStore>,
    tunnel_ids: Option<Vec<String>>,
    bypass_throttle: bool,
) {
    let targets = match store.claim_probe_targets(tunnel_ids, bypass_throttle) {
        Ok(targets) => targets,
        Err(error) => {
            eprintln!("收集隧道探活目标失败：{error}");
            return;
        }
    };
    if targets.is_empty() {
        return;
    }
    // 并发探活：5 条隧道各超时 2s，串行要 10s，并发只要 2s。
    let checks = targets.into_iter().map(|(id, target_url)| async move {
        let health = probe(&target_url).await;
        (id, health)
    });
    let results = futures_util::future::join_all(checks).await;
    if let Err(error) = store.record_health(&results) {
        eprintln!("记录隧道探活结果失败：{error}");
    }
}

/// 探一个目标。任何失败都是 `status: "failed"` 而不是 Err——探活失败是**结果**
/// 不是**错误**,它要显示在面板上,不该让调用链中断。
pub async fn probe(target_url: &str) -> TunnelHealth {
    let checked_at = now_unix_seconds();
    // 目标恒为本机/内网：忽略环境代理，否则 OS 级 HTTP_PROXY 会让探活
    // 打到别处，报出与实际转发路径无关的结果。与数据面的客户端配置一致。
    let client = match reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(PROBE_TIMEOUT)
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            return TunnelHealth::failed(format!("创建探活客户端失败：{error}"), checked_at)
        }
    };
    let started = Instant::now();
    match client.get(target_url).send().await {
        Ok(response) => TunnelHealth {
            status: "ok".to_string(),
            http_status: u32::from(response.status().as_u16()),
            error: String::new(),
            checked_at,
            rtt_ms: started.elapsed().as_millis().min(u128::from(u32::MAX)) as u32,
        },
        Err(error) => TunnelHealth::failed(format!("探活失败：{error}"), checked_at),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn unreachable_target_reports_failed_not_error() {
        // 端口 1 上不会有服务。探活必须返回 failed 而不是 panic 或挂住。
        let health = probe("http://127.0.0.1:1/").await;
        assert_eq!(health.status, "failed");
        assert_eq!(health.http_status, 0);
        assert!(!health.error.is_empty(), "失败要带原因");
        assert!(health.checked_at > 0);
    }

    #[tokio::test]
    async fn malformed_target_reports_failed() {
        let health = probe("not-a-url").await;
        assert_eq!(health.status, "failed");
    }
}
