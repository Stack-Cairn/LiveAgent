import type { ProjectToolTextGenerationClient } from "@liveagent/ui/lib/ai/projectToolTextGeneration";
import { type RefObject, useMemo } from "react";
import {
  assistantMessageToText,
  completeAssistantMessage,
  createProviderRuntimeConfig,
} from "../../../lib/providers/llm";
import type { AppSettings } from "../../../lib/settings";
import type { ConversationRuntimeEntry } from "./chatPageRuntime";
import { resolveEffectiveChatModelSelection } from "./modelSelection";
import { resolveCommitMessageModelSelection } from "./providerRuntimeConfig";

export function useProjectToolTextGenerationClient(params: {
  settings: AppSettings;
  conversationRuntimeCacheRef: RefObject<Map<string, ConversationRuntimeEntry>>;
  currentConversationIdRef: RefObject<string>;
  currentConversationSessionId: string;
}): ProjectToolTextGenerationClient {
  const {
    settings,
    conversationRuntimeCacheRef,
    currentConversationIdRef,
    currentConversationSessionId,
  } = params;

  return useMemo(() => {
    const resolveGenerationSelection = () =>
      resolveCommitMessageModelSelection(settings) ??
      resolveEffectiveChatModelSelection({
        settings,
        conversationSelectedModel: conversationRuntimeCacheRef.current.get(
          currentConversationIdRef.current,
        )?.selectedModel,
      });
    return {
      status: () => {
        try {
          resolveGenerationSelection();
          return "ready";
        } catch {
          return "unconfigured";
        }
      },
      generate: async (request) => {
        const selected = resolveGenerationSelection();
        const runtime = {
          ...createProviderRuntimeConfig(
            selected.provider,
            selected.model,
            settings.chatRuntimeControls,
          ),
          reasoning: "off" as const,
          promptCachingEnabled: false,
          nativeWebSearchEnabled: false,
        };
        const assistant = await completeAssistantMessage({
          providerId: selected.providerId,
          model: selected.model,
          runtime,
          context: {
            systemPrompt: request.systemPrompt,
            messages: [{ role: "user", content: request.userPrompt, timestamp: Date.now() }],
          },
          sessionId: currentConversationSessionId,
          cacheRetention: "none",
          signal: request.signal,
          allowJsonOutput: request.output === "json",
        });
        return assistantMessageToText(assistant);
      },
    } satisfies ProjectToolTextGenerationClient;
  }, [
    conversationRuntimeCacheRef,
    currentConversationIdRef,
    currentConversationSessionId,
    settings,
  ]);
}
