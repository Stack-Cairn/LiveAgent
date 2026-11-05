import { SubagentPane, SubagentRunningChip } from "@liveagent/ui/components/subagents/SubagentPane";
import type { SubagentView } from "@liveagent/ui/contracts/subagentPane";
import type { ChatFileLink } from "@liveagent/ui/lib/chat/chatFileLinks";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { subagentDirectory } from "../../../lib/subagents/kbrainPane";
import {
  closeKBrainSubagentPane,
  closeKBrainSubagentTab,
  countRunningKBrainSubagents,
  getKBrainConversationSubagents,
  loadKBrainSubagents,
  loadKBrainSubagentTranscript,
  openKBrainSubagent,
  showKBrainSubagentDirectory,
  stopKBrainSubagent,
  subscribeKBrainSubagents,
} from "../../../lib/subagents/kbrainSubagentStore";
import { subagentTranscriptItems } from "../../../lib/subagents/kbrainSubagentTranscript";
import { kbrainSubagentView } from "../../../lib/subagents/kbrainSubagentView";

function useConversationSubagents(conversationId: string) {
  return useSyncExternalStore(subscribeKBrainSubagents, () =>
    getKBrainConversationSubagents(conversationId),
  );
}

/**
 * The subagent side pane of one K-brain conversation. Mounting it also loads the
 * conversation's subagents, so cards in reloaded history find theirs.
 */
export function KBrainSubagentPaneHost({
  conversationId,
  workdir,
  onOpenFileLink,
}: {
  conversationId: string;
  workdir?: string;
  onOpenFileLink?: (link: ChatFileLink) => void;
}) {
  const state = useConversationSubagents(conversationId);
  const [pages, setPages] = useState(1);
  useEffect(() => {
    setPages(1);
    void loadKBrainSubagents(conversationId);
  }, [conversationId]);

  const entries = state?.entries;
  const pane = state?.pane;
  const tabs = useMemo(() => {
    const views: SubagentView[] = [];
    for (const id of pane?.tabs ?? []) {
      const entry = entries?.[id];
      if (entry) views.push(kbrainSubagentView(entry));
    }
    return views;
  }, [entries, pane?.tabs]);
  const directory = useMemo(() => {
    const listed = subagentDirectory(
      Object.values(entries ?? {}).map((entry) => entry.subagent),
      pages,
    );
    const view = (id: string) => {
      const entry = entries?.[id];
      return entry ? [kbrainSubagentView(entry)] : [];
    };
    return {
      running: listed.running.flatMap((subagent) => view(subagent.id)),
      ended: listed.ended.flatMap((subagent) => view(subagent.id)),
      endedTotal: listed.endedTotal,
      hasMoreEnded: listed.hasMoreEnded,
    };
  }, [entries, pages]);
  const activeEntry = pane?.active ? entries?.[pane.active] : undefined;
  const activeTranscript = activeEntry?.transcript;
  const live = activeEntry ? kbrainSubagentView(activeEntry).status === "running" : false;
  const transcript = useMemo(() => {
    if (!activeTranscript) return undefined;
    return {
      status: activeTranscript.status,
      ...(activeTranscript.error ? { error: activeTranscript.error } : {}),
      items:
        activeTranscript.status === "ready"
          ? subagentTranscriptItems(activeTranscript.messages, live)
          : [],
    };
  }, [activeTranscript, live]);

  if (!state || !pane?.open) return null;
  return (
    <SubagentPane
      tabs={tabs}
      activeId={pane.active}
      directory={directory}
      transcript={transcript}
      unsupported={state.unsupported}
      workdir={workdir}
      onShowDirectory={() => showKBrainSubagentDirectory(conversationId)}
      onSelectTab={(id) => openKBrainSubagent(conversationId, id)}
      onCloseTab={(id) => closeKBrainSubagentTab(conversationId, id)}
      onClose={() => closeKBrainSubagentPane(conversationId)}
      onShowMore={() => setPages((value) => value + 1)}
      onStop={(id) => stopKBrainSubagent(conversationId, id)}
      onRetryTranscript={(id) => void loadKBrainSubagentTranscript(conversationId, id)}
      onOpenFileLink={onOpenFileLink}
    />
  );
}

/** "{count} running" beside the composer's task progress; opens the directory. */
export function KBrainSubagentRunningChip({ conversationId }: { conversationId: string }) {
  const state = useConversationSubagents(conversationId);
  return (
    <SubagentRunningChip
      count={countRunningKBrainSubagents(state)}
      onOpen={() => showKBrainSubagentDirectory(conversationId)}
    />
  );
}
