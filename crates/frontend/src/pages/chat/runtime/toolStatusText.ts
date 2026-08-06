// core 下发的 tool_status 是 tagged union(lib/protocol/wireEvents.ts 的
// ToolStatus,镜像 core 同名文件),只描述"发生了什么";中文文案在这里生成。
// 本地引擎副本(lib/chat/runner 等)与 wire 事件路径都产出同一个 union,
// 两条路径的渲染由此天然同源,不再依赖字符串逐字一致的约定。

import type { ToolStatus } from "../../../lib/protocol/wireEvents";

/** wire 上是 JSON,故按 kind 逐个窄化。历史别名,与 ToolStatus 同型。 */
export type WireToolStatus = ToolStatus;

const SUBAGENT_PHASE_TEXT: Record<
  Extract<ToolStatus, { kind: "subagent_progress" }>["phase"],
  string
> = {
  worktree_creating: "正在为 %s 创建隔离工作区...",
  worktree_inspecting: "正在检视 %s 的工作区改动...",
  worktree_applying: "正在应用 %s 的工作区改动...",
  worktree_cleanup: "正在清理 %s 的工作区...",
};

function formatParallelTools(toolName: string, count: number) {
  const unit = toolName === "Bash" ? "命令" : "调用";
  return `正在并行执行 ${count} 个 ${toolName} ${unit}...`;
}

function formatCompactionRunning(status: Extract<ToolStatus, { kind: "compaction_running" }>) {
  const detail = `（判定 ${status.total_tokens}/${status.context_window} tokens）`;
  const base =
    status.threshold_mode === "context-window"
      ? `上下文已达到窗口上限${detail}，正在压缩${status.intent === "optimization" ? "历史" : "并恢复"}...`
      : status.intent === "optimization"
        ? `上下文接近上限${detail}，正在压缩历史...`
        : `上下文接近保护阈值${detail}，正在压缩并恢复...`;
  return status.near_model_limit ? `${base} 上下文已接近模型极限，建议适时开启新会话。` : base;
}

/** 未知 kind 返回 null:宁可不显示状态，也不把原始 JSON 糊到用户脸上。 */
export function formatToolStatus(status: ToolStatus | null | undefined): string | null {
  if (!status || typeof status !== "object") return null;
  switch (status.kind) {
    case "model_generating":
      return `第 ${status.round} 轮：模型生成中...`;
    case "tools_preparing":
      return `第 ${status.round} 轮：准备执行 ${status.tool_count} 个工具...`;
    case "tools_resuming":
      return `第 ${status.round} 轮：恢复执行 ${status.tool_count} 个工具...`;
    case "stream_retrying": {
      const retry = `连接已断开，正在重试 (${status.attempt}/${status.max_attempts})...`;
      return status.round === null ? retry : `第 ${status.round} 轮：${retry}`;
    }
    case "tool_running":
      return `正在执行：${status.summary}`;
    case "parallel_tools_running":
      return formatParallelTools(status.tool_name, status.count);
    case "native_web_search":
      return "正在联网搜索...";
    case "compaction_running":
      return formatCompactionRunning(status);
    case "compaction_prune_fallback":
      return `上下文压缩失败，已裁剪 ${status.pruned_message_count} 个旧工具输出后继续...`;
    case "mcp_load_error":
      return `MCP 工具加载失败，已跳过并继续对话：${status.message || "未知错误"}`;
    case "subagent_progress":
      return SUBAGENT_PHASE_TEXT[status.phase].replace("%s", status.agent_name);
    case "ui_stopping":
      return "正在停止当前任务...";
    default:
      return null;
  }
}
