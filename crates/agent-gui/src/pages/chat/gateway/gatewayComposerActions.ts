import type { KBrainGoalState, KBrainSessionLoop } from "../../../lib/kbrain/types";
import type { GatewayComposerActionEvent } from "./gatewayBridgeTypes";

/** 执行 WebUI 非运行指令所需的 K-brain 能力；与 GUI 的指令宿主用同一组客户端函数。 */
export type GatewayComposerActionDeps = {
  /** 未启用 K-brain 后端时为 undefined。 */
  client?: {
    postGoal: (sessionId: string, input: { action: "clear" }) => Promise<KBrainGoalState>;
    listLoops: (sessionId: string) => Promise<KBrainSessionLoop[]>;
    createLoop: (
      sessionId: string,
      input: { cron?: string; interval: string; prompt: string; reasoning?: string },
    ) => Promise<KBrainSessionLoop>;
    cancelLoop: (sessionId: string, loopId: string) => Promise<void>;
  };
  /** LiveAgent 对话 id → K-brain 会话 id（与 GUI 的 getKBrainSessionId 相同映射）。 */
  getKBrainSessionId: (conversationId: string) => string | undefined;
  /** /goal clear 之后把新状态推给桌面目标栏。 */
  onGoalState?: (conversationId: string, state: KBrainGoalState) => void;
};

/**
 * 执行一条 WebUI 转来的 /goal clear 或 /loop 指令，返回交给 Rust 组装响应的 JSON：
 * goal 为 GoalState（conversation_id 换回 LiveAgent 对话 id），loop 一律为 `{loops:[...]}`，
 * 创建时新建的那一项在 loops[0]，取消时为空列表。
 */
export async function runGatewayComposerAction(
  event: GatewayComposerActionEvent,
  deps: GatewayComposerActionDeps,
): Promise<unknown> {
  const { client } = deps;
  if (!client) throw new Error("K-brain backend is not enabled on the desktop");
  const conversationId = event.conversationId.trim();
  if (!conversationId) throw new Error("conversation is unavailable");
  const sessionId = deps.getKBrainSessionId(conversationId)?.trim();
  if (!sessionId) throw new Error("conversation has no K-brain session yet; send a message first");
  const action = event.action.trim();

  if (event.kind === "goal") {
    if (action !== "clear") throw new Error(`unsupported goal action: ${action}`);
    const state = await client.postGoal(sessionId, { action: "clear" });
    deps.onGoalState?.(conversationId, state);
    return { ...state, conversation_id: conversationId };
  }
  if (event.kind === "loop") {
    switch (action) {
      case "list":
        return { loops: await client.listLoops(sessionId) };
      case "create": {
        const cron = event.cron.trim();
        const interval = event.interval.trim();
        const prompt = event.prompt.trim();
        if ((!cron && !interval) || !prompt)
          throw new Error("loop schedule and prompt are required");
        const reasoning = event.reasoning.trim();
        const created = await client.createLoop(sessionId, {
          ...(cron ? { cron } : {}),
          interval,
          prompt,
          ...(reasoning ? { reasoning } : {}),
        });
        return { loops: [created] };
      }
      case "cancel": {
        const loopId = event.loopId.trim();
        if (!loopId) throw new Error("loop id is required");
        await client.cancelLoop(sessionId, loopId);
        return { loops: [] };
      }
      default:
        throw new Error(`unsupported loop action: ${action}`);
    }
  }
  throw new Error(`unsupported composer action: ${event.kind}`);
}
