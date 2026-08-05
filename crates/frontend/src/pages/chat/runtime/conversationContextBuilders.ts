import type { Context, UserMessage } from "@earendil-works/pi-ai";

import {
  buildRequestContext,
  type ConversationViewState,
} from "../../../lib/chat/conversation/conversationState";
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

  return typeof systemPrompt === "string"
    ? {
        ...withTools,
        systemPrompt,
      }
    : withTools;
}

export function buildResumeContext(params: {
  state: ConversationViewState;
  resumeMessage?: UserMessage;
  tools?: Context["tools"];
  activeAgentPrompt: string;
  skillsPrompt: string;
  memoryPrompt?: string;
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
