import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Folder, MessageSquareText, X } from "../../components/icons";
import { Button } from "../../components/ui/button";
import { useLocale } from "../../i18n";
import type {
  ClaudeCodeImportPreview,
  ClaudeCodeImportPreviewSession,
  ClaudeOfficialImportPreview,
} from "../../lib/chat/history/chatHistory";
import { useModalMotion } from "../../lib/shared/modalMotion";
import { cn } from "../../lib/shared/utils";

type ClaudeCodeImportDialogProps = {
  preview: ClaudeCodeImportPreview | ClaudeOfficialImportPreview;
  onClose: () => void;
  onConfirm: (ids: string[]) => void;
  defaultWorkspaceOnly?: boolean;
};

const NO_CWD_KEY = "__liveagent_no_cwd__";
const DEFAULT_WORKSPACE_KEY = "__liveagent_default_workspace__";

function workspaceLabel(cwd: string): string {
  if (cwd === NO_CWD_KEY) return "";
  // 显示路径末段，title 上带完整路径
  const segments = cwd.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? cwd;
}

export function ClaudeCodeImportDialog({
  preview,
  onClose,
  onConfirm,
  defaultWorkspaceOnly = false,
}: ClaudeCodeImportDialogProps) {
  const { t } = useLocale();
  const { modalState, requestClose } = useModalMotion(onClose);

  const groups = useMemo(() => {
    if (defaultWorkspaceOnly) {
      return [
        ["__liveagent_default_workspace__", preview.sessions] as [
          string,
          ClaudeCodeImportPreviewSession[],
        ],
      ];
    }
    const map = new Map<string, ClaudeCodeImportPreviewSession[]>();
    for (const session of preview.sessions) {
      const key = session.cwd?.trim() ? session.cwd : NO_CWD_KEY;
      const list = map.get(key);
      if (list) list.push(session);
      else map.set(key, [session]);
    }
    // 按会话数倒序，default-project 置顶
    return Array.from(map.entries()).sort((a, b) => {
      const aIsDefault = a[0].includes("default-project");
      const bIsDefault = b[0].includes("default-project");
      if (aIsDefault !== bIsDefault) return aIsDefault ? -1 : 1;
      return b[1].length - a[1].length;
    });
  }, [preview.sessions, defaultWorkspaceOnly]);

  const [activeCwdKey, setActiveCwdKey] = useState<string | null>(groups[0]?.[0] ?? null);

  const [selected, setSelected] = useState<Set<string>>(() => {
    const set = new Set<string>();
    for (const session of preview.sessions) {
      if (!session.alreadyImported) set.add(session.id);
    }
    return set;
  });

  const activeSessions = useMemo(
    () => groups.find(([key]) => key === activeCwdKey)?.[1] ?? [],
    [groups, activeCwdKey],
  );

  const groupSelectedCount = (key: string) => {
    const list = groups.find(([k]) => k === key)?.[1] ?? [];
    return list.filter((s) => selected.has(s.id)).length;
  };

  function toggleSession(session: ClaudeCodeImportPreviewSession) {
    if (session.alreadyImported) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(session.id)) next.delete(session.id);
      else next.add(session.id);
      return next;
    });
  }

  function toggleGroup(key: string) {
    const list = groups.find(([k]) => k === key)?.[1] ?? [];
    const importable = list.filter((s) => !s.alreadyImported);
    if (importable.length === 0) return;
    const allSelected = importable.every((s) => selected.has(s.id));
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) {
        for (const s of importable) next.delete(s.id);
      } else {
        for (const s of importable) next.add(s.id);
      }
      return next;
    });
  }

  const activeSessionsAllSelected =
    activeSessions.length > 0 &&
    activeSessions.filter((s) => !s.alreadyImported).every((s) => selected.has(s.id));

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
            <Folder className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold">
              {defaultWorkspaceOnly
                ? t("chat.history.claudeOfficialImportDialogTitle")
                : t("chat.history.claudeCodeImportDialogTitle")}
            </h2>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {defaultWorkspaceOnly
                ? t("chat.history.claudeOfficialImportDialogSubtitle")
                : t("chat.history.claudeCodeImportDialogSubtitle")}
            </p>
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
              <span>{t("chat.history.claudeCodeImportDialogWorkspaces")}</span>
              <button
                type="button"
                onClick={() => {
                  const anyUnselected = preview.sessions.some(
                    (s) => !s.alreadyImported && !selected.has(s.id),
                  );
                  setSelected(() => {
                    const next = new Set<string>();
                    if (anyUnselected) {
                      preview.sessions.forEach((s) => {
                        if (!s.alreadyImported) next.add(s.id);
                      });
                    }
                    return next;
                  });
                }}
                className="text-primary hover:underline"
              >
                {preview.sessions.some((s) => !s.alreadyImported && !selected.has(s.id))
                  ? t("chat.history.claudeCodeImportDialogAll")
                  : t("chat.history.claudeCodeImportDialogNone")}
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-1.5">
              {groups.length === 0 ? (
                <p className="px-2 py-4 text-xs text-muted-foreground">
                  {t("chat.history.claudeCodeImportDialogEmpty")}
                </p>
              ) : (
                groups.map(([key, list]) => {
                  const isActive = key === activeCwdKey;
                  const checked = groupSelectedCount(key);
                  const importable = list.filter((s) => !s.alreadyImported).length;
                  const allSelected = importable > 0 && checked === importable;
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
                          toggleGroup(key);
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
                      <Folder
                        className={cn(
                          "h-3.5 w-3.5 shrink-0",
                          isActive ? "text-primary" : "text-muted-foreground",
                        )}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium">
                          {key === NO_CWD_KEY
                            ? t("chat.history.claudeCodeImportDialogNoWorkspace")
                            : key === DEFAULT_WORKSPACE_KEY
                              ? t("chat.history.claudeOfficialImportDialogDefaultWorkspace")
                              : workspaceLabel(key)}
                        </span>
                        {key !== NO_CWD_KEY && key !== DEFAULT_WORKSPACE_KEY ? (
                          <span
                            className="block truncate text-[10px] text-muted-foreground"
                            title={key}
                          >
                            {key}
                          </span>
                        ) : null}
                      </span>
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {checked}/{importable}
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
                {activeCwdKey === NO_CWD_KEY
                  ? t("chat.history.claudeCodeImportDialogNoWorkspace")
                  : activeCwdKey === DEFAULT_WORKSPACE_KEY
                    ? t("chat.history.claudeOfficialImportDialogDefaultWorkspace")
                    : (activeCwdKey ?? "")}
              </span>
              {activeSessions.length > 0 ? (
                <button
                  type="button"
                  onClick={() => toggleGroup(activeCwdKey ?? NO_CWD_KEY)}
                  className="text-[11px] text-primary hover:underline"
                >
                  {activeSessionsAllSelected
                    ? t("chat.history.claudeCodeImportDialogNone")
                    : t("chat.history.claudeCodeImportDialogAll")}
                </button>
              ) : null}
            </div>
            <div className="flex-1 overflow-y-auto p-2">
              {activeSessions.length === 0 ? (
                <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                  {t("chat.history.claudeCodeImportDialogEmpty")}
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
                          {session.model} · {session.messageCount}{" "}
                          {t("chat.history.claudeCodeImportDialogMessages")}
                        </span>
                      </span>
                      {session.alreadyImported ? (
                        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          {t("chat.history.claudeCodeImportDialogAlreadyImported")}
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
            {t("chat.history.claudeCodeImportDialogSelected").replace(
              "{count}",
              String(selected.size),
            )}
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
              {t("chat.history.claudeCodeImportDialogImport").replace(
                "{count}",
                String(selected.size),
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
