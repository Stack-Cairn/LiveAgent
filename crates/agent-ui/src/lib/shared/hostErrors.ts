/**
 * 宿主能力缺失的识别。桌面宿主命令在另外两个运行面上不存在：K-brain 浏览器
 * 宿主（`shims/tauriCore` 直接拒绝）与 Gateway WebUI（`shims/tauriCore` 的
 * switch 未覆盖）。这两类文案是给开发者看的内部诊断，不是用户操作失败——
 * 顶在输入框下方或设置页里只会让人以为自己的仓库/驱动坏了。
 *
 * 调用方据此改用自己的本地化提示；真实失败（权限、路径、网络）原样透出。
 */
export function isHostCommandUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return (
    /unavailable in K-brain (browser )?mode/i.test(message) ||
    /WebUI shim does not implement/i.test(message)
  );
}

/**
 * 统一的错误文案出口：宿主能力缺失 → 用调用方给的本地化提示；真实失败 →
 * 原样透出（空串时退回 `fallback`）。项目工具面板的每个 catch 都走这里，
 * 免得新增入口时又忘记过滤内部诊断。
 */
export function hostAwareErrorMessage(
  error: unknown,
  unavailableMessage: string,
  fallback = "",
): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (isHostCommandUnavailable(error) && unavailableMessage.trim() !== "") {
    return unavailableMessage;
  }
  return message.trim() !== "" ? message : fallback;
}
