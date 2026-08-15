import type { Context, UserMessage } from "@earendil-works/pi-ai";

import {
  buildRequestContext,
  type ConversationViewState,
} from "../../../lib/chat/conversation/conversationState";
import {
  attachMemoryTurnUpdates,
  type MemoryTurnUpdateMap,
} from "../../../lib/memory/prompts/turnInjection";
import { appendSystemPrompt } from "./chatPageRuntime";

export type ConversationContextBuildOptions = {
  includeAbortedMessages?: boolean;
  includeUploadedFilesMetadata?: boolean;
};

export function buildCompactionContext(
  state: ConversationViewState,
  tools?: Context["tools"],
  options?: ConversationContextBuildOptions,
): Context {
  const baseContext = buildRequestContext(state, options);
  return Array.isArray(tools) && tools.length > 0
    ? {
        ...baseContext,
        tools,
      }
    : baseContext;
}

export function buildPreparedContext(params: {
  state: ConversationViewState;
  tools?: Context["tools"];
  activeAgentPrompt: string;
  skillsPrompt: string;
  memoryPrompt?: string;
  memoryTurnUpdates?: MemoryTurnUpdateMap | null;
  includeAbortedMessages?: boolean;
  includeUploadedFilesMetadata?: boolean;
}): Context {
  // AGENTS / Skills prompts are fixed runtime instructions and should not be
  // folded into compaction input or token accounting.
  const withTools = buildCompactionContext(params.state, params.tools, {
    includeAbortedMessages: params.includeAbortedMessages,
    includeUploadedFilesMetadata: params.includeUploadedFilesMetadata,
  });

  let systemPrompt = withTools.systemPrompt;
  if (params.activeAgentPrompt) {
    systemPrompt = appendSystemPrompt(systemPrompt, params.activeAgentPrompt);
  }
  if (params.skillsPrompt) {
    systemPrompt = appendSystemPrompt(systemPrompt, params.skillsPrompt);
  }
  if (params.memoryPrompt) {
    systemPrompt = appendSystemPrompt(systemPrompt, params.memoryPrompt);
  }

  // memory 的动态部分挂在对应 user 消息尾部,而不是继续往 system 段里塞:
  // system 段一变,整条缓存前缀连同全部历史一起作废。
  const messages = attachMemoryTurnUpdates(withTools.messages, params.memoryTurnUpdates);
  const withMessages = messages === withTools.messages ? withTools : { ...withTools, messages };

  return typeof systemPrompt === "string"
    ? {
        ...withMessages,
        systemPrompt,
      }
    : withMessages;
}

export function buildResumeContext(params: {
  state: ConversationViewState;
  resumeMessage?: UserMessage;
  tools?: Context["tools"];
  activeAgentPrompt: string;
  skillsPrompt: string;
  memoryPrompt?: string;
  memoryTurnUpdates?: MemoryTurnUpdateMap | null;
  includeAbortedMessages?: boolean;
  includeUploadedFilesMetadata?: boolean;
}): Context {
  const baseContext = buildPreparedContext({
    ...params,
    includeAbortedMessages: params.includeAbortedMessages,
  });
  if (!params.resumeMessage) {
    return baseContext;
  }
  return {
    ...baseContext,
    messages: [...baseContext.messages, params.resumeMessage],
  };
}
