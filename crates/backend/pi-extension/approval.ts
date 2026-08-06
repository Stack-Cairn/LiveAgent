// LiveAgent 工具审批挂点。
//
// 这是本项目唯一的 pi TS 扩展（能力清单 B14 备案的「零 TS 扩展」例外）。
// 原因：pi 没有内置审批协议，拦截工具调用的唯一挂点就是扩展的 `tool_call`
// 事件（可返回 `{block:true}`）；而扩展要问用户，只能走 `ctx.ui.*`，
// 它在 RPC 模式下投影成 stdout 的 `extension_ui_request`。
//
// 刻意做成**无策略的哑管道**：这里不判断哪个工具该审批、不读设置、不记
// 免审。所有裁决都在 Rust（backend 的 pi/approval.rs）。这样策略怎么变都
// 不用回来改 TS —— 维护 TS 的成本正是我们想避开的东西。
//
// 协议（与 Rust 侧一一对应）：
//   请求：ctx.ui.select(MARKER + <JSON>, ...) → Rust 从 title 里认出 MARKER
//   应答：value === ""  → 放行
//         value 非空    → 拦截，字符串本身就是给模型看的理由
//         undefined     → 拦截，用兜底理由（正常流程走不到，见下）
//
// 「空串放行、非空即理由」省掉了在两侧各写一遍 JSON 编解码；理由要原样
// 交给模型，本来就是个字符串。措辞的区分（用户拒绝 / 审批超时）也在 Rust 侧，
// 这里不参与判断。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MARKER = "liveagent-approval-v1:";

/**
 * 对话框没给出任何值时的兜底。
 *
 * 正常流程走不到：Rust 对每个带 MARKER 的请求都会回一个明确的字符串
 * （超时也会——它自己有 3 分钟窗口，超时回的是「未获确认」那句）。
 * 留着是防 pi 侧提前取消对话框，取向与 pi 自身「tool_call 出错即拦截」一致。
 */
const FALLBACK_REASON = "工具审批未得到应答，已按拒绝处理。不要重试。";

/** 单个参数值的截断长度。write 的 content 能有几十 KB，全塞进 title 纯属浪费。 */
const MAX_VALUE_CHARS = 200;

/** 只保留够 Rust 拼状态文案的那点信息，长值截断。 */
function summarizeInput(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    out[key] =
      typeof value === "string" && value.length > MAX_VALUE_CHARS
        ? `${value.slice(0, MAX_VALUE_CHARS)}…`
        : value;
  }
  return out;
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    const request = JSON.stringify({
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: summarizeInput(event.input),
    });

    const verdict = await ctx.ui.select(MARKER + request, ["allow", "deny"]);

    if (verdict === "") return undefined;
    return { block: true, reason: verdict || FALLBACK_REASON };
  });
}
