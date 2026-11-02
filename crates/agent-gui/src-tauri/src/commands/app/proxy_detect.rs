use crate::services::proxy_detect::{self, ProxyDetectResult, ProxyTestInput, ProxyTestResult};

/// 应用代理设置：列出本机握手通过的代理服务（WebUI 经 Gateway 的 proxy_detect 通道调用同一实现）。
#[tauri::command]
pub async fn system_proxy_detect() -> Result<ProxyDetectResult, String> {
    Ok(proxy_detect::detect().await)
}

/// 经检测到的代理访问固定地址测延迟；未被检测到的地址一律拒绝。
#[tauri::command]
pub async fn system_proxy_test(input: ProxyTestInput) -> Result<ProxyTestResult, String> {
    proxy_detect::test(input).await
}
