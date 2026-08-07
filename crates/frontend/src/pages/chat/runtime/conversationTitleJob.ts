import type { MutableRefObject } from "react";
import { backendFetch } from "../../../lib/backend/client";
import type { SelectedModel } from "../../../lib/settings";
import type { SidebarStore } from "../../../lib/sidebar/store";

type TitleJobRefValue = {
  conversationId: string;
  promise: Promise<string | null>;
} | null;

type StartConversationTitleJobParams = {
  signal: AbortSignal;
  conversationId: string;
  titleSourceText: string;
  /**
   * 会话当前选定的模型。标题模型（若单独配置）与 locale 都由引擎从设置里解析，
   * 前端不再自己拼 provider 运行时。
   */
  selectedModel?: SelectedModel;
  // Only the pending row's title is streamed into the sidebar; persisted rows
  // are renamed through the history IPC by the caller.
  sidebarStore: Pick<SidebarStore, "peek" | "upsertLocal">;
  titleJobRef: MutableRefObject<TitleJobRefValue>;
};

/**
 * 标题生成走引擎（`conversation_title_generate`）：前端只发起、等结果、写侧边栏。
 * 引擎是同步返回的一次性请求，所以没有流式预览；失败一律得到 null，pending 行
 * 保留默认标题。
 */
export function startConversationTitleJob(params: StartConversationTitleJobParams) {
  const { signal, conversationId, titleSourceText, selectedModel, sidebarStore, titleJobRef } =
    params;

  const titlePromise = backendFetch<{ title: string | null }>(
    "conversation_title_generate",
    { titleSourceText, selectedModel },
    signal,
  )
    .then((result) => result?.title || null)
    .catch(() => null);

  titleJobRef.current = {
    conversationId,
    promise: titlePromise,
  };

  void titlePromise
    .then((resolvedTitle) => {
      if (!resolvedTitle) return;
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
