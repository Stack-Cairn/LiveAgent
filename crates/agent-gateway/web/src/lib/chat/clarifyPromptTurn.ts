// crates/agent-gateway/web/src/lib/chat/clarifyPromptTurn.ts
import type { ClarifyMessage } from "@liveagent/ui/components/chat/clarify/clarifyTypes";
import type { ClarifyTurnResult } from "@/lib/gatewaySocketRpc";
import {
  type AppSettings,
  type ChatRuntimeControls,
  type CustomProvider,
  normalizeChatRuntimeControlsForProvider,
  resolvePromptClarifyModel,
} from "@/lib/settings";

/** clarify.prompt_turn 的最小 API 面（GatewayWebSocketRpcClient 子集）。 */
export type ClarifyPromptTurnApi = {
  clarifyPromptTurn(
    input: {
      messages: ClarifyMessage[];
      providerId: string;
      model: string;
      runtimeControls?: ChatRuntimeControls;
    },
    options?: { onDelta?: (delta: string) => void },
  ): Promise<ClarifyTurnResult>;
};

/**
 * Web 两个宿主（GatewayAppView 内联 composer / workbench Pane）共用的澄清轮次
 * 执行逻辑：设置里的「澄清对话模型」优先，未选或失效时落回 fallback（宿主各自
 * 的当前会话模型）；覆盖生效时 runtime controls 按覆盖供应商/模型重新归一化。
 * 经 gateway 中继到桌面宿主跑一轮纯文本补全；onTextDelta 把流式增量推回面板。
 */
export async function executeClarifyPromptTurn(
  api: ClarifyPromptTurnApi,
  settings: AppSettings,
  fallback: {
    provider: CustomProvider | undefined;
    model: string | undefined;
    runtimeControls: ChatRuntimeControls | undefined;
  },
  messages: ClarifyMessage[],
  onTextDelta?: (delta: string) => void,
): Promise<string> {
  const override = resolvePromptClarifyModel(settings);
  const provider = override?.provider ?? fallback.provider;
  const model = override?.model ?? fallback.model;
  if (!provider || !model) {
    throw new Error("no active model selected");
  }
  const result = await api.clarifyPromptTurn(
    {
      messages,
      providerId: provider.id,
      model,
      runtimeControls: override
        ? normalizeChatRuntimeControlsForProvider(settings.chatRuntimeControls, {
            providerId: provider.type,
            requestFormat: provider.requestFormat,
            modelId: model,
          })
        : fallback.runtimeControls,
    },
    onTextDelta ? { onDelta: onTextDelta } : undefined,
  );
  if (result.error_code) {
    throw new Error(result.error_message || result.error_code);
  }
  return result.final_text;
}
