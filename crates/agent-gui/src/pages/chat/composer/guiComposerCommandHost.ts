import type { MentionComposerDraft } from "@liveagent/ui/components/chat/MentionComposerModel";
import {
  type ComposerCommandHost,
  type ComposerTurnCommand,
  findModelOptionByName,
} from "@liveagent/ui/lib/chat/composerCommands";
import type { SharedModelOption } from "@liveagent/ui/lib/models/modelOptions";
import { parseModelValue } from "@liveagent/ui/lib/models/modelValue";
import type { ChatRuntimeControls } from "@liveagent/ui/lib/settings/types";
import type { KBrainClient } from "../../../lib/kbrain/client";
import type { KBrainGoalState } from "../../../lib/kbrain/types";
import type { SelectedModel } from "../../../lib/settings";
import type { ManualCompactionResult } from "../runtime/useManualCompaction";

/**
 * GUI 的“/”指令宿主。指令目录、目标和 /loop 都由 K-brain 提供（GET /v1/commands、
 * /v1/sessions/{id}/goal、/v1/sessions/{id}/loops），输入框只负责草稿与分发。会随
 * 运行变化的读数走 getter，调用方据此让同一会话的宿主引用保持稳定——输入框按
 * 宿主引用重新拉目录。
 */
export function createGuiComposerCommandHost(params: {
  t: (key: string) => string;
  /** K-brain 客户端；不传时只有 Skill 弹层，指令一概不注册。 */
  client?: KBrainClient;
  /** 当前对话映射到的 K-brain 会话；新对话首轮发出前还没有。 */
  getKBrainSessionId: () => string | undefined;
  getWorkdir: () => string | undefined;
  /** 当前会话的推理/联网开关；/plan 任务以它为底只打开 planModeEnabled。 */
  getRuntimeControls: () => ChatRuntimeControls;
  /**
   * 发送一轮消息；options.planMode 只作用于这一轮。options.draft 是带会话引用、
   * 大段粘贴的草稿，发送层按普通草稿处理（含待上传附件）。会话正忙时应抛错；
   * 返回 false 表示发送在开始前被拒。
   */
  sendTurn: (
    text: string,
    command?: ComposerTurnCommand,
    options?: {
      planMode?: boolean;
      runtimeControls?: ChatRuntimeControls;
      draft?: MentionComposerDraft;
    },
  ) => unknown;
  /** 输入框正在编辑排队消息时返回 true，指令不拦截。 */
  isDraftReserved?: () => boolean;
  compact: () => Promise<ManualCompactionResult>;
  getModelOptions: () => readonly SharedModelOption[];
  selectModel: (selection: SelectedModel) => void;
  /** 目标状态变化（如 /goal clear）回给目标栏。 */
  onGoalState?: (state: KBrainGoalState) => void;
  /** 指令结果写进会话后重新加载转录区。 */
  reloadConversation?: () => Promise<unknown>;
}): ComposerCommandHost {
  const { t, client } = params;
  const host: ComposerCommandHost = {
    compact: async () => {
      const result = await params.compact();
      if (result.status !== "compacted") {
        throw new Error(result.message || t("chat.commands.failed"));
      }
    },
    selectModel: (name) => {
      const option = findModelOptionByName(
        params.getModelOptions(),
        name,
        t("chat.commands.modelNotFound"),
      );
      const selection = parseModelValue(option.value);
      if (!selection) throw new Error(`${t("chat.commands.modelNotFound")}: ${name}`);
      params.selectModel(selection);
    },
  };
  if (!client) return host;
  const sessionId = () => {
    const id = params.getKBrainSessionId()?.trim();
    if (!id) throw new Error(t("chat.commands.needsConversation"));
    return id;
  };
  host.listCommands = async () =>
    (await client.listCommands(params.getWorkdir())).map((command) => ({
      name: command.name,
      description: command.description,
      argumentHint: command.argument_hint,
      kind: command.kind,
      source: command.source,
    }));
  host.carriesComposerContext = true;
  if (params.isDraftReserved) host.isDraftReserved = params.isDraftReserved;
  host.sendTurn = async (text, command, options) => {
    const accepted = await params.sendTurn(text, command, {
      ...options,
      runtimeControls: options?.planMode
        ? { ...params.getRuntimeControls(), planModeEnabled: true }
        : undefined,
    });
    // 发送层在开始前拒绝（会话加载中、粘贴导入进行中等）时返回 false：转成错误，
    // 输入框据此放回草稿并显示原因。已开始的轮次（含被停止的）返回 true。
    if (accepted === false) throw new Error(t("chat.commands.failed"));
    return accepted;
  };
  host.recordCommandResult = async (command, result) => {
    await client.recordCommandNote(sessionId(), command, result);
    await params.reloadConversation?.();
  };
  host.clearGoal = async () => {
    const state = await client.postGoal(sessionId(), { action: "clear" });
    params.onGoalState?.(state);
  };
  host.pauseGoal = async () => {
    const state = await client.postGoal(sessionId(), { action: "pause" });
    params.onGoalState?.(state);
  };
  host.loops = {
    create: async (interval, prompt) => {
      return client.createLoop(sessionId(), { interval, prompt });
    },
    list: () => client.listLoops(sessionId()),
    cancel: (id) => client.cancelLoop(sessionId(), id),
  };
  return host;
}
