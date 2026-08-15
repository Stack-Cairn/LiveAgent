import { getAssistantAvatarUrl } from "@liveagent/adapters/assistantAvatar";
import { AlertCircle, Loader2, MessageSquareText } from "@liveagent/ui/components/IconSet";
import { ScrollArea } from "@liveagent/ui/components/ui/scroll-area";
import { useEffect, useMemo, useState } from "react";
import { GatewayTranscript } from "../components/GatewayTranscript";
import { buildRowsFromEntries, dedupeRowKeys } from "../lib/chat/transcript/rows";
import type { ChatEntry } from "../lib/chatUi";
import type { SharedHistoryDetail } from "../lib/gatewayTypes";
import { parseHistoryMessagesJsonAsync } from "../lib/historyParser";
import { fetchSharedHistory, formatSharedHistoryTimestamp } from "../lib/historyShare";

type SharedHistoryPageProps = {
  token: string;
};

type SharedHistoryState =
  | { status: "loading"; detail?: undefined; entries?: undefined; error?: undefined }
  | { status: "ready"; detail: SharedHistoryDetail; entries: ChatEntry[]; error?: undefined }
  | { status: "error"; detail?: undefined; entries?: undefined; error: string };

export function SharedHistoryPage({ token }: SharedHistoryPageProps) {
  const [state, setState] = useState<SharedHistoryState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });

    void (async () => {
      try {
        const detail = await fetchSharedHistory(token);
        const entries = await parseHistoryMessagesJsonAsync(detail.messages_json);
        if (!cancelled) {
          setState({ status: "ready", detail, entries });
        }
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : String(error ?? "");
          setState({ status: "error", error: message || "读取分享会话失败" });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [token]);

  const summary = state.status === "ready" ? state.detail.conversation : undefined;
  const title = summary?.title?.trim() || "分享会话";
  const updatedAt = useMemo(
    () => formatSharedHistoryTimestamp(summary?.updated_at),
    [summary?.updated_at],
  );
  const transcriptRows = useMemo(
    () =>
      state.status === "ready" ? dedupeRowKeys(buildRowsFromEntries(state.entries, "history")) : [],
    [state],
  );

  return (
    <div className="gateway-shell history-share-page">
      <main className="gateway-main-shell">
        <div className="gateway-main-backdrop" />
        <div className="history-share-frame">
          <header className="history-share-header">
            <div className="flex min-w-0 items-center gap-3">
              <img
                src={getAssistantAvatarUrl()}
                alt=""
                aria-hidden="true"
                draggable={false}
                className="h-10 w-10 shrink-0 select-none rounded-2xl object-contain"
              />
              <div className="min-w-0">
                <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
                  LiveAgent Shared Conversation
                </div>
                <h1 className="mt-1 truncate text-lg font-semibold text-foreground" title={title}>
                  {title}
                </h1>
              </div>
            </div>
            {state.status === "ready" ? (
              <div className="history-share-meta">
                <span>{summary?.message_count ?? state.entries.length} 条消息</span>
                {updatedAt ? <span>{updatedAt}</span> : null}
              </div>
            ) : null}
          </header>

          <section className="history-share-body">
            {state.status === "loading" ? (
              <div className="history-share-state">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                <div className="text-sm font-medium text-foreground/85">正在加载分享会话</div>
              </div>
            ) : state.status === "error" ? (
              <div className="history-share-state">
                <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-destructive/25 bg-destructive/10 text-destructive">
                  <AlertCircle className="h-5 w-5" />
                </div>
                <div className="text-sm font-medium text-foreground/85">{state.error}</div>
                <div className="max-w-md text-center text-xs leading-5 text-muted-foreground">
                  分享可能已被关闭，或桌面端当前不在线。
                </div>
              </div>
            ) : state.entries.length === 0 ? (
              <div className="history-share-state">
                <MessageSquareText className="h-5 w-5 text-muted-foreground" />
                <div className="text-sm font-medium text-foreground/85">该会话暂无可展示内容</div>
              </div>
            ) : (
              <ScrollArea className="history-share-scroll">
                <GatewayTranscript
                  conversationId={state.detail.conversation_id}
                  rows={transcriptRows}
                  readOnly
                  redactToolContent={state.detail.redact_tool_content === true}
                />
              </ScrollArea>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
