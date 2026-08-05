import type { MutableRefObject } from "react";
import type { Locale } from "../../../i18n/config";
import type { BackendBridgeEventController } from "../../../lib/chat/conversation/run";
import {
  buildConversationTitlePrompt,
  buildConversationTitleSystemPrompt,
  normalizeGeneratedConversationTitle,
} from "../../../lib/chat/page/chatPageHelpers";
import { assistantMessageToText, streamAssistantMessage } from "../../../lib/providers/llm";
import type { ProviderId } from "../../../lib/settings";
import type { SidebarStore } from "../../../lib/sidebar/store";

type TitleJobRefValue = {
  conversationId: string;
  promise: Promise<string | null>;
} | null;

type StartConversationTitleJobParams = {
  providerId: ProviderId;
  model: string;
  runtime: Parameters<typeof streamAssistantMessage>[0]["runtime"];
  signal: AbortSignal;
  conversationId: string;
  titleSourceText: string;
  content: string;
  /**
   * UI locale; the generated title language follows it. Required so a new
   * caller cannot silently fall back to Chinese titles in an English UI.
   */
  locale: Locale;
  // Only the pending row's title is streamed into the sidebar; persisted rows
  // are renamed through the history IPC by the caller.
  sidebarStore: Pick<SidebarStore, "peek" | "upsertLocal">;
  titleJobRef: MutableRefObject<TitleJobRefValue>;
  backendBridgeEvents: BackendBridgeEventController;
};

const GATEWAY_BRIDGE_TITLE_MIN_INTERVAL_MS = 250;

export function buildConversationTitleRuntime(
  runtime: Parameters<typeof streamAssistantMessage>[0]["runtime"],
): Parameters<typeof streamAssistantMessage>[0]["runtime"] {
  return {
    ...runtime,
    reasoning: "off",
    promptCachingEnabled: false,
    nativeWebSearchEnabled: false,
  };
}

export function startConversationTitleJob(params: StartConversationTitleJobParams) {
  const {
    providerId,
    model,
    runtime,
    signal,
    conversationId,
    titleSourceText,
    content,
    locale,
    sidebarStore,
    titleJobRef,
    backendBridgeEvents,
  } = params;
  let streamedTitle = "";
  let lastForwardedGatewayTitle = "";
  let lastForwardedGatewayTitleAt = 0;

  const forwardGatewayTitlePreview = (preview: string, force = false) => {
    const title = preview.trim();
    if (!title || title === lastForwardedGatewayTitle) {
      return;
    }
    const now = Date.now();
    if (!force && now - lastForwardedGatewayTitleAt < GATEWAY_BRIDGE_TITLE_MIN_INTERVAL_MS) {
      return;
    }
    lastForwardedGatewayTitle = title;
    lastForwardedGatewayTitleAt = now;
    backendBridgeEvents.queueTitle(title, force);
  };

  const titleRuntime = buildConversationTitleRuntime(runtime);

  const titlePromise = streamAssistantMessage({
    providerId,
    model,
    runtime: titleRuntime,
    signal,
    cacheRetention: "none",
    nativeWebSearch: false,
    context: {
      systemPrompt: buildConversationTitleSystemPrompt(locale),
      messages: [
        {
          role: "user",
          content: buildConversationTitlePrompt(titleSourceText || content, locale),
          timestamp: Date.now(),
        },
      ],
    },
    onTextDelta: (delta) => {
      streamedTitle += delta;
      const preview = streamedTitle
        .replace(/[\r\n]+/g, " ")
        .replace(/^[`"'""'']+|[`"'""'']+$/g, "")
        .trim();
      if (!preview) return;
      forwardGatewayTitlePreview(preview);
      const currentItem = sidebarStore.peek(conversationId);
      if (!currentItem?.isPending) return;
      sidebarStore.upsertLocal({
        ...currentItem,
        title: preview,
        updatedAt: Date.now(),
      });
    },
  })
    .then((assistant) => normalizeGeneratedConversationTitle(assistantMessageToText(assistant)))
    .then((title) => title || null)
    .catch(() => null);

  titleJobRef.current = {
    conversationId,
    promise: titlePromise,
  };

  void titlePromise
    .then((resolvedTitle) => {
      if (!resolvedTitle) return;
      forwardGatewayTitlePreview(resolvedTitle, true);
      const currentItem = sidebarStore.peek(conversationId);
      if (!currentItem?.isPending) return;
      if (currentItem.title === resolvedTitle) return;
      sidebarStore.upsertLocal({
        ...currentItem,
        title: resolvedTitle,
        updatedAt: Date.now(),
      });
    })
    .catch(() => {
      // ignore title preview failures; the pending row keeps the default title
    });

  return titlePromise;
}
