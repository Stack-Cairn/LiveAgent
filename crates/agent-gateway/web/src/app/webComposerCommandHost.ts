import {
  type ComposerCommandHost,
  type ComposerTurnCommand,
  findModelOptionByName,
} from "@liveagent/ui/lib/chat/composerCommands";
import type { SharedModelOption } from "@liveagent/ui/lib/models/modelOptions";
import type { ChatRuntimeControls } from "@liveagent/ui/lib/settings/types";
import type {
  GoalManageResponse,
  LoopManageResponse,
  SlashCommandListResponse,
} from "../lib/gatewaySocketShared";

/** WebUI 指令宿主依赖的 Gateway RPC 子集，由 Gateway 转到目标运行端。 */
export type WebComposerCommandClient = {
  listCommands: (workdir?: string) => Promise<SlashCommandListResponse>;
  clearGoal: (conversationId: string) => Promise<GoalManageResponse>;
  listLoops: (conversationId: string) => Promise<LoopManageResponse>;
  createLoop: (input: {
    conversationId: string;
    cron?: string;
    interval: string;
    prompt: string;
  }) => Promise<LoopManageResponse>;
  cancelLoop: (conversationId: string, loopId: string) => Promise<LoopManageResponse>;
};

/**
 * WebUI 的“/”指令宿主，与 GUI 一致：目录由 K-brain 提供，/goal 与提示词指令
 * 随聊天请求一起发给桌面端执行；/goal clear 与 /loop 经 Gateway 转发。
 * /plan 与 /rewind 由 ChatComposerBar 按运行时开关与回退上下文补上。
 */
export function createWebComposerCommandHost(params: {
  t: (key: string) => string;
  client?: WebComposerCommandClient;
  /** 当前对话 id；本地草稿对话（还没发过消息）返回 undefined。 */
  getConversationId: () => string | undefined;
  getWorkdir: () => string | undefined;
  getRuntimeControls: () => ChatRuntimeControls;
  sendTurn: (
    text: string,
    command?: ComposerTurnCommand,
    runtimeControls?: ChatRuntimeControls,
  ) => unknown;
  /** 不提供时 /compact 与 /model 不出现在目录里（背景 Pane 就是这样）。 */
  compact?: () => unknown;
  getModelOptions?: () => readonly SharedModelOption[];
  selectModel?: (value: string) => void;
}): ComposerCommandHost {
  const { t, client } = params;
  const host: ComposerCommandHost = {};
  if (params.compact) host.compact = params.compact;
  if (params.selectModel && params.getModelOptions) {
    const select = params.selectModel;
    const options = params.getModelOptions;
    host.selectModel = (name) => {
      select(findModelOptionByName(options(), name, t("chat.commands.modelNotFound")).value);
    };
  }
  if (!client) return host;
  const conversationId = () => {
    const id = params.getConversationId()?.trim();
    if (!id) throw new Error(t("chat.commands.needsConversation"));
    return id;
  };
  host.listCommands = async () =>
    (await client.listCommands(params.getWorkdir())).commands.map((command) => ({
      name: command.name,
      description: command.description,
      argumentHint: command.argumentHint,
      kind: command.kind === "action" ? "action" : "prompt",
      source: command.source,
    }));
  host.sendTurn = (text, command, options) =>
    params.sendTurn(
      text,
      options?.planMode ? { kind: "plan" } : command,
      options?.planMode ? { ...params.getRuntimeControls(), planModeEnabled: true } : undefined,
    );
  host.clearGoal = () => client.clearGoal(conversationId());
  host.loops = {
    create: async (interval, prompt) => {
      const created = await client.createLoop({
        conversationId: conversationId(),
        interval,
        prompt,
      });
      const entry = created.loops[0];
      if (!entry) throw new Error(t("chat.commands.failed"));
      return entry;
    },
    list: async () => (await client.listLoops(conversationId())).loops,
    cancel: async (id) => {
      await client.cancelLoop(conversationId(), id);
    },
  };
  return host;
}
