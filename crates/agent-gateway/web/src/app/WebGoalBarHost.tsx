import { ComposerGoalBar } from "@liveagent/ui/components/chat/ComposerGoalBar";
import { toast } from "@liveagent/ui/components/ui/toast-manager";
import type { ComposerCommandHost } from "@liveagent/ui/lib/chat/composerCommands";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  catalogSupportsGoalResume,
  goalBarState,
  goalStateFromResponse,
  publishGoalState,
  readGoalRevision,
  readGoalState,
  subscribeGoalState,
} from "@/lib/chat/goalState";
import type { GoalManageResponse } from "@/lib/gatewaySocketShared";

/** 目标栏用到的 Gateway RPC 子集（goal.manage 的 get/pause/update/clear）。 */
export type WebGoalBarClient = {
  getGoal: (conversationId: string) => Promise<GoalManageResponse>;
  manageGoal: (
    conversationId: string,
    input: { action: "pause" | "clear" } | { action: "update"; goal: string },
  ) => Promise<GoalManageResponse>;
};

// 运行结束后桌面端还要核对一次目标（goalSettle），稍后再读一次拿到最终状态。
const SETTLE_REFRESH_MS = 1500;

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** 运行端能否续跑目标：直连 K-brain 的网关不把 /goal 列进目录，也不接受 goal_action。 */
const resumeSupport = new WeakMap<ComposerCommandHost, Promise<boolean>>();
function supportsGoalResume(host: ComposerCommandHost | undefined): Promise<boolean> {
  if (!host?.listCommands || !host.sendTurn) return Promise.resolve(false);
  let pending = resumeSupport.get(host);
  if (!pending) {
    pending = host
      .listCommands()
      .then(catalogSupportsGoalResume)
      .catch(() => false);
    resumeSupport.set(host, pending);
  }
  return pending;
}

/**
 * WebUI 的目标栏，行为与 GUI 的 KBrainGoalBarHost 一致：显示当前对话的会话目标，
 * 可暂停、修改与清除，暂停后经输入框的 /goal resume 发送链路继续。切到对话时与运行
 * 结束后主动读取一次；运行中的进度来自 goal_updated 推送。读取失败（例如旧版桌面端
 * 不支持读取目标）时不显示。
 */
export function WebGoalBarHost({
  conversationId,
  client,
  commandHost,
  running,
}: {
  /** 本地草稿对话传 undefined。 */
  conversationId: string | undefined;
  client: WebGoalBarClient | undefined;
  commandHost?: ComposerCommandHost;
  running: boolean;
}) {
  const id = conversationId?.trim() ?? "";
  const state = useSyncExternalStore(
    useCallback(
      (notify: () => void) =>
        subscribeGoalState((changed) => {
          if (changed === id) notify();
        }),
      [id],
    ),
    () => readGoalState(id),
  );
  const [canResume, setCanResume] = useState(false);

  const refresh = useCallback(async () => {
    if (!client || !id) return;
    const revision = readGoalRevision(id);
    try {
      const next = goalStateFromResponse(await client.getGoal(id));
      // 读取期间有推送或操作结果时丢弃这次较旧的读取。
      if (readGoalRevision(id) === revision) publishGoalState(id, next);
    } catch {
      // 会话还没有后端会话或运行端不支持读取：目标栏保持现状（通常不显示）。
    }
  }, [client, id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const wasRunning = useRef(running);
  useEffect(() => {
    const finished = wasRunning.current && !running;
    wasRunning.current = running;
    if (!finished) return;
    void refresh();
    const timer = window.setTimeout(() => void refresh(), SETTLE_REFRESH_MS);
    return () => window.clearTimeout(timer);
  }, [refresh, running]);

  useEffect(() => {
    let cancelled = false;
    void supportsGoalResume(commandHost).then((supported) => {
      if (!cancelled) setCanResume(supported);
    });
    return () => {
      cancelled = true;
    };
  }, [commandHost]);

  const bar = client && id ? goalBarState(state) : null;
  if (!bar || !client) return null;

  const manage = async (
    input: { action: "pause" | "clear" } | { action: "update"; goal: string },
  ) => {
    try {
      publishGoalState(id, goalStateFromResponse(await client.manageGoal(id, input)));
    } catch (error) {
      toast.error(errorText(error));
    }
  };

  return (
    <ComposerGoalBar
      state={bar}
      actions={{
        onPause: () => manage({ action: "pause" }),
        onUpdate: (goal) => manage({ action: "update", goal }),
        onClear: () => manage({ action: "clear" }),
        ...(canResume
          ? {
              onResume: async () => {
                try {
                  await commandHost?.sendTurn?.("/goal resume", { kind: "goal", action: "resume" });
                } catch (error) {
                  // 例如会话仍在运行：提示原因，目标保持暂停。
                  toast.error(errorText(error));
                }
              },
            }
          : {}),
      }}
    />
  );
}
