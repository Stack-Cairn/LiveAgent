import { useCallback, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Folder, MessageSquareText, X } from "../../components/icons";
import { Button } from "../../components/ui/button";
import { useLocale } from "../../i18n";
import type { ImportPreview, ImportPreviewSession } from "../../lib/chat/history/chatHistory";
import { useImportSelection } from "../../lib/chat/history/useImportSelection";
import { useModalMotion } from "../../lib/shared/modalMotion";
import { cn } from "../../lib/shared/utils";

export type ImportSource = "codex" | "claude-code" | "claude-official";

type ImportDialogProps = {
  source: ImportSource;
  preview: ImportPreview;
  onClose: () => void;
  onConfirm: (ids: string[]) => void;
};

const NO_CWD_KEY = "__liveagent_no_cwd__";
const CHAT_MODE_KEY = "__liveagent_chat_mode__";

function workspaceLabel(cwd: string): string {
  if (cwd === NO_CWD_KEY || cwd === CHAT_MODE_KEY) return "";
  const segments = cwd.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? cwd;
}

const LABELS: Record<
  ImportSource,
  {
    title: string;
    subtitle: string;
    workspaces: string;
    noWorkspace: string;
    chatMode?: string;
    empty: string;
    all: string;
    none: string;
    selected: string;
    import: string;
    alreadyImported: string;
    messages: string;
  }
> = {
  codex: {
    title: "chat.history.codexImportDialogTitle",
    subtitle: "chat.history.codexImportDialogSubtitle",
    workspaces: "chat.history.codexImportDialogWorkspaces",
    noWorkspace: "chat.history.codexImportDialogNoWorkspace",
    empty: "chat.history.codexImportDialogEmpty",
    all: "chat.history.codexImportDialogAll",
    none: "chat.history.codexImportDialogNone",
    selected: "chat.history.codexImportDialogSelected",
    import: "chat.history.codexImportDialogImport",
    alreadyImported: "chat.history.codexImportDialogAlreadyImported",
    messages: "chat.history.codexImportDialogMessages",
  },
  "claude-code": {
    title: "chat.history.claudeCodeImportDialogTitle",
    subtitle: "chat.history.claudeCodeImportDialogSubtitle",
    workspaces: "chat.history.claudeCodeImportDialogWorkspaces",
    noWorkspace: "chat.history.claudeCodeImportDialogNoWorkspace",
    empty: "chat.history.claudeCodeImportDialogEmpty",
    all: "chat.history.claudeCodeImportDialogAll",
    none: "chat.history.claudeCodeImportDialogNone",
    selected: "chat.history.claudeCodeImportDialogSelected",
    import: "chat.history.claudeCodeImportDialogImport",
    alreadyImported: "chat.history.claudeCodeImportDialogAlreadyImported",
    messages: "chat.history.claudeCodeImportDialogMessages",
  },
  "claude-official": {
    title: "chat.history.claudeOfficialImportDialogTitle",
    subtitle: "chat.history.claudeOfficialImportDialogSubtitle",
    workspaces: "settings.executionMode",
    noWorkspace: "chat.history.claudeCodeImportDialogNoWorkspace",
    chatMode: "settings.chatMode",
    empty: "chat.history.claudeOfficialImportDialogEmpty",
    all: "chat.history.claudeCodeImportDialogAll",
    none: "chat.history.claudeCodeImportDialogNone",
    selected: "chat.history.claudeCodeImportDialogSelected",
    import: "chat.history.claudeCodeImportDialogImport",
    alreadyImported: "chat.history.claudeCodeImportDialogAlreadyImported",
    messages: "chat.history.claudeCodeImportDialogMessages",
  },
};

function buildGroups(
  source: ImportSource,
  sessions: ImportPreviewSession[],
): [string, ImportPreviewSession[]][] {
  if (source === "claude-official") {
    return [[CHAT_MODE_KEY, sessions]];
  }
  const map = new Map<string, ImportPreviewSession[]>();
  for (const session of sessions) {
    const key = session.cwd?.trim() ? session.cwd : NO_CWD_KEY;
    const list = map.get(key);
    if (list) list.push(session);
    else map.set(key, [session]);
  }
  return Array.from(map.entries()).sort((a, b) => {
    if (source === "codex") {
      const aDefault = a[0].includes("default-project");
      const bDefault = b[0].includes("default-project");
      if (aDefault !== bDefault) return aDefault ? -1 : 1;
    }
    const aNoCwd = a[0] === NO_CWD_KEY;
    const bNoCwd = b[0] === NO_CWD_KEY;
    if (aNoCwd !== bNoCwd) return aNoCwd ? 1 : -1;
    return b[1].length - a[1].length;
  });
}

export function ImportDialog({ source, preview, onClose, onConfirm }: ImportDialogProps) {
  const { t } = useLocale();
  const { modalState, requestClose } = useModalMotion(onClose);
  const labels = LABELS[source];
  const isOfficial = source === "claude-official";
  const WorkspaceIcon = isOfficial ? MessageSquareText : Folder;

  const groups = useMemo(() => buildGroups(source, preview.sessions), [source, preview.sessions]);
  const [activeCwdKey, setActiveCwdKey] = useState<string | null>(groups[0]?.[0] ?? null);

  const { selected, toggleSession, toggleGroup, selectAll, selectNone, isAllSelected } =
    useImportSelection(preview.sessions);

  const formatKey = useCallback(
    (key: string) => {
      if (key === CHAT_MODE_KEY) return t(labels.chatMode ?? "settings.chatMode");
      if (key === NO_CWD_KEY) return t(labels.noWorkspace);
      return workspaceLabel(key);
    },
    [labels, t],
  );

  const activeSessions = useMemo(
    () => groups.find(([key]) => key === activeCwdKey)?.[1] ?? [],
    [groups, activeCwdKey],
  );

  const groupImportable = (list: ImportPreviewSession[]) =>
    list.filter((session) => !session.alreadyImported);

  const activeSessionsAllSelected =
    activeSessions.length > 0 &&
    groupImportable(activeSessions).every((session) => selected.has(session.id));

  return createPortal(
    <div
      className="settings-modal-overlay fixed inset-0 z-50 flex items-center justify-center p-4"
      data-state={modalState}
      role="dialog"
      aria-modal="true"
    >
      <button
        type="button"
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        aria-label={t("settings.cancel")}
        onClick={requestClose}
      />
      <div className="settings-modal-panel relative z-10 flex max-h-[88vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-border/60 bg-background shadow-2xl">
        <div className="settings-modal-header flex items-center gap-3 border-b border-border/40 px-6 py-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-border/55 bg-background/80 text-foreground/85">
            <WorkspaceIcon className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold">{t(labels.title)}</h2>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{t(labels.subtitle)}</p>
          </div>
          <button
            type="button"
            onClick={requestClose}
            title={t("settings.cancel")}
            aria-label={t("settings.cancel")}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="settings-modal-body flex flex-1 gap-px overflow-hidden bg-border/40 px-0 py-0">
          {/* 左栏：工作区 */}
          <div className="flex w-56 shrink-0 flex-col bg-card">
            <div className="flex items-center justify-between border-b border-border/40 px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              <span>{t(labels.workspaces)}</span>
              <button
                type="button"
                onClick={isAllSelected ? selectNone : selectAll}
                className="text-primary hover:underline"
              >
                {isAllSelected ? t(labels.none) : t(labels.all)}
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-1.5">
              {groups.length === 0 ? (
                <p className="px-2 py-4 text-xs text-muted-foreground">{t(labels.empty)}</p>
              ) : (
                groups.map(([key, list]) => {
                  const isActive = key === activeCwdKey;
                  const checked = list.filter((session) => selected.has(session.id)).length;
                  const importable = groupImportable(list);
                  const allSelected = importable.length > 0 && checked === importable.length;
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setActiveCwdKey(key)}
                      className={cn(
                        "mb-1 flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors",
                        isActive ? "bg-primary/10" : "hover:bg-muted/50",
                      )}
                    >
                      <button
                        type="button"
                        aria-pressed={allSelected}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleGroup(list);
                        }}
                        className={cn(
                          "flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                          allSelected
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border bg-background",
                        )}
                      >
                        {allSelected ? <Check className="h-3 w-3" /> : null}
                      </button>
                      <WorkspaceIcon
                        className={cn(
                          "h-3.5 w-3.5 shrink-0",
                          isActive ? "text-primary" : "text-muted-foreground",
                        )}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium">{formatKey(key)}</span>
                        {key !== NO_CWD_KEY && key !== CHAT_MODE_KEY ? (
                          <span
                            className="block truncate text-[10px] text-muted-foreground"
                            title={key}
                          >
                            {key}
                          </span>
                        ) : null}
                      </span>
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {checked}/{importable.length}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </div>

          {/* 右栏：会话 */}
          <div className="flex flex-1 flex-col bg-background">
            <div className="flex items-center justify-between border-b border-border/40 px-4 py-2">
              <span className="text-xs text-muted-foreground">
                {formatKey(activeCwdKey ?? NO_CWD_KEY)}
              </span>
              {activeSessions.length > 0 ? (
                <button
                  type="button"
                  onClick={() => toggleGroup(activeSessions)}
                  className="text-[11px] text-primary hover:underline"
                >
                  {activeSessionsAllSelected ? t(labels.none) : t(labels.all)}
                </button>
              ) : null}
            </div>
            <div className="flex-1 overflow-y-auto p-2">
              {activeSessions.length === 0 ? (
                <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                  {t(labels.empty)}
                </p>
              ) : (
                activeSessions.map((session) => {
                  const checked = selected.has(session.id);
                  return (
                    <button
                      key={session.id}
                      type="button"
                      onClick={() => toggleSession(session)}
                      disabled={session.alreadyImported}
                      className={cn(
                        "mb-1 flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
                        session.alreadyImported
                          ? "cursor-not-allowed opacity-50"
                          : "hover:bg-muted/50",
                      )}
                    >
                      <span
                        className={cn(
                          "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                          checked
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border bg-background",
                        )}
                      >
                        {checked ? <Check className="h-3 w-3" /> : null}
                      </span>
                      <MessageSquareText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium">{session.title}</span>
                        <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
                          {session.model} · {session.messageCount} {t(labels.messages)}
                        </span>
                      </span>
                      {session.alreadyImported ? (
                        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          {t(labels.alreadyImported)}
                        </span>
                      ) : null}
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </div>

        <div className="settings-modal-footer flex items-center justify-between gap-3 border-t border-border/40 px-6 py-4">
          <span className="text-xs text-muted-foreground">
            {t(labels.selected).replace("{count}", String(selected.size))}
          </span>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" onClick={requestClose}>
              {t("settings.cancel")}
            </Button>
            <Button
              type="button"
              onClick={() => onConfirm(Array.from(selected))}
              disabled={selected.size === 0}
            >
              {t(labels.import).replace("{count}", String(selected.size))}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
