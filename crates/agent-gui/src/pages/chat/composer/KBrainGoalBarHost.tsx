import {
  ComposerGoalBar,
  type ComposerGoalBarState,
} from "@liveagent/ui/components/chat/ComposerGoalBar";
import { toast } from "@liveagent/ui/components/ui/toast-manager";
import type { ComposerCommandHost } from "@liveagent/ui/lib/chat/composerCommands";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { createKBrainClient } from "../../../lib/kbrain/client";
import { publishGoalState, readGoalState, subscribeGoalState } from "../../../lib/kbrain/goalStore";
import { getKBrainSessionId } from "../../../lib/kbrain/mapping";
import type { KBrainGoalState } from "../../../lib/kbrain/types";

function barState(state: KBrainGoalState | undefined): ComposerGoalBarState | null {
  if (!state?.goal) return null;
  if (state.status !== "active" && state.status !== "continuing" && state.status !== "paused") {
    return null;
  }
  const startedAt = state.started_at ? Date.parse(state.started_at) : Number.NaN;
  return {
    goal: state.goal,
    status: state.status,
    round: state.round,
    maxRounds: state.max_rounds,
    reason: state.reason,
    startedAt: Number.isFinite(startedAt) ? startedAt : undefined,
  };
}

/**
 * GUI 的目标栏：显示当前对话的 K-brain 目标，目标达成或清除后消失。切换到对话时
 * 主动读一次目标状态（应用重启后恢复的目标是暂停态）；恢复走输入框的 /goal resume
 * 发送链路，好让续跑轮次照常出现在转录区。
 */
export function KBrainGoalBarHost({
  conversationId,
  commandHost,
  enabled,
}: {
  conversationId: string;
  commandHost?: ComposerCommandHost;
  enabled: boolean;
}) {
  const [client] = useState(() => createKBrainClient());
  const state = useSyncExternalStore(
    useCallback(
      (notify: () => void) =>
        subscribeGoalState((changed) => {
          if (changed === conversationId.trim()) notify();
        }),
      [conversationId],
    ),
    () => readGoalState(conversationId),
  );

  useEffect(() => {
    if (!enabled) return;
    const sessionId = getKBrainSessionId(conversationId);
    if (!sessionId) return;
    let cancelled = false;
    void client
      .getGoal(sessionId)
      .then((next) => {
        if (!cancelled) publishGoalState(conversationId, next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client, conversationId, enabled]);

  const bar = enabled ? barState(state) : null;
  if (!bar) return null;

  const withSession = async (action: (sessionId: string) => Promise<KBrainGoalState>) => {
    const sessionId = getKBrainSessionId(conversationId);
    if (!sessionId) return;
    try {
      publishGoalState(conversationId, await action(sessionId));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <ComposerGoalBar
      state={bar}
      disabled={!commandHost?.sendTurn}
      actions={{
        onPause: () => withSession((id) => client.postGoal(id, { action: "pause" })),
        onUpdate: (goal) => withSession((id) => client.postGoal(id, { action: "update", goal })),
        onClear: () => withSession((id) => client.postGoal(id, { action: "clear" })),
        onResume: async () => {
          try {
            await commandHost?.sendTurn?.("/goal resume", { kind: "goal", action: "resume" });
          } catch (error) {
            // 例如会话仍在运行：提示原因，目标保持暂停。
            toast.error(error instanceof Error ? error.message : String(error));
          }
        },
      }}
    />
  );
}
