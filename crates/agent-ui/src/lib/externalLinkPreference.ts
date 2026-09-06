// 本地界面偏好：跨会话、重启保留，不随远端 Agent 设置同步。
const STORAGE_KEY = "liveagent:skip-external-link-confirmation:v1";
let skipForSession = false;

export function shouldSkipExternalLinkConfirmation(): boolean {
  try {
    return skipForSession || globalThis.localStorage?.getItem(STORAGE_KEY) === "true";
  } catch {
    return skipForSession;
  }
}

export function rememberExternalLinkConfirmation(): void {
  skipForSession = true;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, "true");
  } catch {
    // 存储不可用时仍打开链接，偏好降级为本次运行有效。
  }
}
