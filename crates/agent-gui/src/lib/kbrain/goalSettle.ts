import type { KBrainClient } from "./client";
import type { KBrainGoalState } from "./types";

/**
 * 一次带目标的轮次结束后对齐目标状态。用户停止时先暂停目标：后端可能已在上一轮
 * 结束后自行发起下一轮，而前端还没挂接上，不暂停它就会在后台继续跑；没有进行中
 * 的目标时后端回 409，忽略即可。之后再读一次目标，目标栏不会停在停止前的状态
 * （停止会中断事件流，后端发出的暂停事件收不到）。
 */
export async function settleGoalAfterTurn(params: {
  client: Pick<KBrainClient, "getGoal" | "postGoal">;
  conversationId: string;
  sessionId: string | undefined;
  stopped: boolean;
  publish: (conversationId: string, state: KBrainGoalState) => void;
}): Promise<void> {
  const sessionId = params.sessionId?.trim();
  if (!sessionId) return;
  if (params.stopped) {
    try {
      params.publish(
        params.conversationId,
        await params.client.postGoal(sessionId, { action: "pause" }),
      );
      return;
    } catch {
      // 409：目标已暂停、达成或不存在；照常读取当前状态。
    }
  }
  try {
    params.publish(params.conversationId, await params.client.getGoal(sessionId));
  } catch {
    // 读取失败只影响目标栏刷新，不影响本轮结果。
  }
}
