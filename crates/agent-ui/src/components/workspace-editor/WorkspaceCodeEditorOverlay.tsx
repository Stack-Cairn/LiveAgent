import {
  readWorkspaceClipboardText,
  WorkspaceOverlayTitleBar,
  workspaceOverlayStackClassName,
} from "@liveagent/adapters/workspacePreview";
import type { IconComponent } from "@liveagent/ui/components/IconSet";
import {
  AlertTriangle,
  ClipboardPaste,
  Cloud,
  Copy,
  Eye,
  FilePenLine,
  Loader2,
  MessageSquareText,
  Redo2,
  RefreshCw,
  Replace,
  Save,
  Scissors,
  Search,
  TextSelect,
  Undo2,
  WrapText,
  X,
} from "@liveagent/ui/components/IconSet";
import {
  AlertDialog,
  AlertDialogActions,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@liveagent/ui/components/ui/alert-dialog";
import { Button, RefreshButton } from "@liveagent/ui/components/ui/button";
import {
  ContextMenuPopup,
  ContextMenuItem as StandardContextMenuItem,
} from "@liveagent/ui/components/ui/context-menu";
import { EmptyState } from "@liveagent/ui/components/ui/empty-state";
import { KbdShortcut } from "@liveagent/ui/components/ui/kbd";
import { isWorkspacePreviewPath } from "@liveagent/ui/components/workspace-editor/workspaceImagePreview";
import { useLocale } from "@liveagent/ui/i18n/index";
import { isMacLikePlatform } from "@liveagent/ui/lib/chat/commandPalette";
import {
  type CodeMentionReference,
  createCodeMentionReference,
} from "@liveagent/ui/lib/chat/mentionReferences";
import * as monaco from "@liveagent/ui/lib/monacoEditor";
import type { SftpClient } from "@liveagent/ui/lib/sftp/types";
import { cn } from "@liveagent/ui/lib/shared/utils";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import CssWorker from "monaco-editor/languages/features/css/css.worker.js?worker";
import HtmlWorker from "monaco-editor/languages/features/html/html.worker.js?worker";
import JsonWorker from "monaco-editor/languages/features/json/json.worker.js?worker";
import TsWorker from "monaco-editor/languages/features/typescript/ts.worker.js?worker";
import {
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  createRemoteSftpEditorFileIo,
  type EditorFileIo,
  type EditorRemoteSource,
  isEditorFileTooLarge,
  localEditorFileIo,
} from "./workspaceEditorFileIo";

type MonacoEnvironmentGlobal = typeof globalThis & {
  MonacoEnvironment?: {
    getWorker: (workerId: string, label: string) => Worker;
  };
};

const monacoGlobal = globalThis as MonacoEnvironmentGlobal;

if (!monacoGlobal.MonacoEnvironment) {
  monacoGlobal.MonacoEnvironment = {
    getWorker(_workerId, label) {
      if (label === "json") return new JsonWorker();
      if (label === "css" || label === "scss" || label === "less") return new CssWorker();
      if (label === "html" || label === "handlebars" || label === "razor") {
        return new HtmlWorker();
      }
      if (label === "typescript" || label === "javascript") return new TsWorker();
      return new EditorWorker();
    },
  };
}

export type WorkspaceCodeEditorOpenRequest = {
  id: number;
  projectPathKey: string;
  workdir: string;
  path: string;
  line?: number;
  endLine?: number;
  column?: number;
  // Present when the file lives on the remote side of an SFTP session; its
  // content is then read/written through the SSH connection instead of the
  // workspace fs backend.
  remote?: EditorRemoteSource;
};

type EditorTabStatus = "ready" | "saving" | "reloading" | "conflict";

// Full text lives here only until this tab first acquires a Monaco model.
// After that, the model (including its undo stack and BOM/EOL) owns the text.
type EditorTabBuffer = {
  initialContent: string | null;
  savedVersionId: number | null;
  lightweight: boolean;
  savePromise: Promise<boolean> | null;
  reloadToken: symbol | null;
};

const LARGE_EDITOR_BYTES = 1024 * 1024;
const LARGE_EDITOR_LINES = 20_000;
const LONG_EDITOR_LINE = 10_000;

function needsLightweightEditor(content: string, sizeBytes: number, totalLines: number) {
  if (sizeBytes >= LARGE_EDITOR_BYTES || totalLines >= LARGE_EDITOR_LINES) return true;
  let lineLength = 0;
  for (let index = 0; index < content.length; index += 1) {
    const code = content.charCodeAt(index);
    lineLength = code === 10 || code === 13 ? 0 : lineLength + 1;
    if (lineLength >= LONG_EDITOR_LINE) return true;
  }
  return false;
}

function editorPerformanceOptions(lightweight: boolean): monaco.editor.IEditorOptions {
  return {
    minimap: { enabled: !lightweight },
    folding: !lightweight,
    glyphMargin: !lightweight,
    fontLigatures: !lightweight,
    renderWhitespace: "none",
    renderLineHighlight: lightweight ? "none" : "line",
    matchBrackets: lightweight ? "never" : "always",
    occurrencesHighlight: lightweight ? "off" : "singleFile",
    selectionHighlight: !lightweight,
    colorDecorators: !lightweight,
    stickyScroll: { enabled: !lightweight },
    stopRenderingLineAfter: LONG_EDITOR_LINE,
    // Keep find/replace available without automatically searching for a huge selection.
    find: { seedSearchStringFromSelection: lightweight ? "never" : "always" },
  };
}

type EditorTab = {
  key: string;
  projectPathKey: string;
  workdir: string;
  path: string;
  dirty: boolean;
  mtimeMs: number;
  contentHash: string;
  sizeBytes: number;
  totalLines: number;
  language: string;
  status: EditorTabStatus;
  error: string | null;
  remote?: EditorRemoteSource;
};

type PendingDialog =
  | { kind: "closeOverlay" }
  | { kind: "closeTab"; tabKey: string }
  | { kind: "reloadTab"; tabKey: string };

type EditorContextMenuState = {
  x: number;
  y: number;
};

const EDITOR_OVERLAY_ANIMATION_MS = 180;

type WorkspaceCodeEditorOverlayProps = {
  openRequest: WorkspaceCodeEditorOpenRequest | null;
  closeRequestId?: number;
  isOpen: boolean;
  finalCloseRequested?: boolean;
  theme: "light" | "dark";
  sftpClient?: SftpClient;
  onPreviewFile: (request: WorkspaceCodeEditorOpenRequest & { textRange?: boolean }) => void;
  onInsertCodeMention?: (reference: CodeMentionReference) => void;
  onHide: () => void;
  onClose: () => void;
};

function editorTabKey(projectPathKey: string, path: string, remote?: EditorRemoteSource) {
  // Remote tabs carry the session id so a remote file never collides with a
  // local file that happens to share the same path string.
  const sourceTag = remote ? `sftp:${remote.sessionId}` : "";
  return `${projectPathKey}\u0000${sourceTag}\u0000${path}`;
}

function basename(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

function dirname(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return index > 0 ? normalized.slice(0, index) : "";
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function toMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) return error.message;
  const text = String(error ?? "").trim();
  return text || fallback;
}

function editorModelUri(tabKey: string) {
  const bytes = new TextEncoder().encode(tabKey);
  let hexKey = "";
  for (const byte of bytes) {
    hexKey += byte.toString(16).padStart(2, "0");
  }
  return monaco.Uri.from({
    scheme: "liveagent-editor",
    authority: "model",
    path: `/${hexKey}`,
  });
}

/** Monaco's own chords; redo and replace use different keys per platform. */
function getEditorContextMenuShortcuts() {
  const isMac = isMacLikePlatform();
  return {
    undo: "Mod+KeyZ",
    redo: isMac ? "Mod+Shift+KeyZ" : "Ctrl+KeyY",
    cut: "Mod+KeyX",
    copy: "Mod+KeyC",
    paste: "Mod+KeyV",
    selectAll: "Mod+KeyA",
    find: "Mod+KeyF",
    replace: isMac ? "Alt+Mod+KeyF" : "Ctrl+KeyH",
  } as const;
}

export function WorkspaceCodeEditorOverlay(props: WorkspaceCodeEditorOverlayProps) {
  const {
    openRequest,
    closeRequestId,
    isOpen,
    finalCloseRequested = false,
    theme,
    sftpClient,
    onPreviewFile,
    onInsertCodeMention,
    onHide,
    onClose,
  } = props;
  const { t } = useLocale();
  const contextMenuShortcuts = useMemo(() => getEditorContextMenuShortcuts(), []);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelsRef = useRef(new Map<string, monaco.editor.ITextModel>());
  const buffersRef = useRef(new Map<string, EditorTabBuffer>());
  const tabsRef = useRef<EditorTab[]>([]);
  const openReadsRef = useRef(new Map<string, { request: WorkspaceCodeEditorOpenRequest }>());
  const mountedRef = useRef(true);
  const isOpenRef = useRef(isOpen);
  isOpenRef.current = isOpen;
  const dialogActionRef = useRef(false);
  const viewStatesRef = useRef(new Map<string, monaco.editor.ICodeEditorViewState | null>());
  const editorModelKeyRef = useRef("");
  const linkedLocationKeyRef = useRef("");
  const activeKeyRef = useRef("");
  const openRequestIdRef = useRef<number | null>(null);
  const closeRequestIdRef = useRef<number | null>(null);
  const openAnimationFrameRef = useRef<number | null>(null);
  const closeAnimationTimeoutRef = useRef<number | null>(null);
  const performanceModeRef = useRef<boolean | null>(null);
  const [tabs, setTabs] = useState<EditorTab[]>([]);
  const [activeKey, setActiveKey] = useState("");
  const [openingPaths, setOpeningPaths] = useState<string[]>([]);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [pendingDialog, setPendingDialog] = useState<PendingDialog | null>(null);
  const [contextMenu, setContextMenu] = useState<EditorContextMenuState | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [dialogSaving, setDialogSaving] = useState(false);
  const [wordWrap, setWordWrap] = useState(false);

  // Async I/O and Monaco events must observe edits immediately, before React renders.
  const setEditorTabs = useCallback((updater: (current: EditorTab[]) => EditorTab[]) => {
    const next = updater(tabsRef.current);
    if (next === tabsRef.current) return;
    tabsRef.current = next;
    setTabs(next);
  }, []);

  const tabNeedsSave = useCallback((tab: EditorTab) => {
    const buffer = buffersRef.current.get(tab.key);
    const model = modelsRef.current.get(tab.key);
    return (
      Boolean(buffer?.savePromise) ||
      (model && buffer ? model.getAlternativeVersionId() !== buffer.savedVersionId : tab.dirty)
    );
  }, []);

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.key === activeKey) ?? tabs[0] ?? null,
    [activeKey, tabs],
  );
  const lightweightTab = Boolean(activeTab && buffersRef.current.get(activeTab.key)?.lightweight);
  const canPreviewActiveTab = Boolean(
    activeTab && (lightweightTab || (!activeTab.remote && isWorkspacePreviewPath(activeTab.path))),
  );
  const isOpening = openingPaths.length > 0;

  useEffect(() => {
    openAnimationFrameRef.current = window.requestAnimationFrame(() => {
      openAnimationFrameRef.current = null;
      setIsVisible(true);
    });
    return () => {
      if (openAnimationFrameRef.current !== null) {
        window.cancelAnimationFrame(openAnimationFrameRef.current);
      }
      if (closeAnimationTimeoutRef.current !== null) {
        window.clearTimeout(closeAnimationTimeoutRef.current);
      }
    };
  }, []);

  const cancelPendingClose = useCallback(() => {
    if (closeAnimationTimeoutRef.current === null) return;
    window.clearTimeout(closeAnimationTimeoutRef.current);
    closeAnimationTimeoutRef.current = null;
    setIsVisible(true);
  }, []);

  const finishHide = useCallback(() => {
    if (closeAnimationTimeoutRef.current !== null) return;
    setIsVisible(false);
    closeAnimationTimeoutRef.current = window.setTimeout(() => {
      closeAnimationTimeoutRef.current = null;
      onHide();
    }, EDITOR_OVERLAY_ANIMATION_MS);
  }, [onHide]);

  const finishClose = useCallback(
    (discard = false) => {
      const discardedVersions = discard
        ? new Map(
            tabsRef.current.map((tab) => [
              tab.key,
              {
                buffer: buffersRef.current.get(tab.key),
                version: modelsRef.current.get(tab.key)?.getVersionId(),
              },
            ]),
          )
        : null;
      if (closeAnimationTimeoutRef.current !== null) {
        window.clearTimeout(closeAnimationTimeoutRef.current);
        closeAnimationTimeoutRef.current = null;
      }
      setIsVisible(false);
      closeAnimationTimeoutRef.current = window.setTimeout(() => {
        closeAnimationTimeoutRef.current = null;
        // Keyboard edits can arrive during the exit animation, too.
        if (
          tabsRef.current.some((tab) => {
            const buffer = buffersRef.current.get(tab.key);
            const discarded = discardedVersions?.get(tab.key);
            const editedAfterDiscard =
              discardedVersions &&
              (discarded?.buffer !== buffer ||
                discarded?.version !== modelsRef.current.get(tab.key)?.getVersionId());
            return buffer?.savePromise || editedAfterDiscard || (!discard && tabNeedsSave(tab));
          })
        ) {
          setIsVisible(true);
          setPendingDialog({ kind: "closeOverlay" });
          return;
        }
        openReadsRef.current.clear();
        onClose();
      }, EDITOR_OVERLAY_ANIMATION_MS);
    },
    [onClose, tabNeedsSave],
  );

  const updateTab = useCallback(
    (tabKey: string, updater: (tab: EditorTab) => EditorTab) => {
      setEditorTabs((current) => {
        let changed = false;
        const next = current.map((tab) => {
          if (tab.key !== tabKey) return tab;
          const updated = updater(tab);
          changed ||= updated !== tab;
          return updated;
        });
        return changed ? next : current;
      });
    },
    [setEditorTabs],
  );

  const disposeModel = useCallback((tabKey: string) => {
    const model = modelsRef.current.get(tabKey);
    if (model) {
      if (editorRef.current?.getModel() === model) {
        editorRef.current.setModel(null);
      }
      model.dispose();
      modelsRef.current.delete(tabKey);
    }
    if (editorModelKeyRef.current === tabKey) {
      editorModelKeyRef.current = "";
    }
    viewStatesRef.current.delete(tabKey);
    buffersRef.current.delete(tabKey);
  }, []);

  const ioForSource = useCallback(
    (projectPathKey: string, remote: EditorRemoteSource | undefined): EditorFileIo => {
      if (!remote) return localEditorFileIo;
      if (!sftpClient) {
        throw new Error(t("workspaceEditor.remoteUnavailable"));
      }
      return createRemoteSftpEditorFileIo({
        sftpClient,
        sessionId: remote.sessionId,
        projectPathKey,
        onTooLarge: () => t("workspaceEditor.remoteTooLarge"),
      });
    },
    [sftpClient, t],
  );

  const saveTab = useCallback(
    async (tabKey: string): Promise<boolean> => {
      const tab = tabsRef.current.find((item) => item.key === tabKey);
      const buffer = buffersRef.current.get(tabKey);
      if (!tab || !buffer) return false;
      // A second save/close must await the actual write, even if undo has made
      // the model look clean relative to the previous on-disk baseline.
      if (buffer.savePromise) return buffer.savePromise;
      if (buffer.reloadToken) return false;
      if (!tabNeedsSave(tab)) return true;
      if (tab.status === "conflict") {
        setGlobalError(tab.error ?? t("workspaceEditor.conflictMessage"));
        return false;
      }
      const model = modelsRef.current.get(tabKey);
      if (!model) return false;
      // Separate subsequent typing from the saved undo state. Preserve BOM and
      // Monaco's detected EOL when materializing the sole full-text snapshot.
      model.pushStackElement();
      const savedVersionId = model.getAlternativeVersionId();
      const contentToSave = model.getValue(undefined, true);
      updateTab(tabKey, (current) => ({ ...current, status: "saving", error: null }));
      const operation = (async () => {
        // Install savePromise before calling a transport (including synchronous failures).
        await Promise.resolve();
        try {
          const io = ioForSource(tab.projectPathKey, tab.remote);
          const result = await io.write({
            workdir: tab.workdir,
            path: tab.path,
            content: contentToSave,
            expectedMtimeMs: tab.mtimeMs,
            expectedContentHash: tab.contentHash,
            expectedSizeBytes: tab.sizeBytes,
          });
          if (!mountedRef.current || buffersRef.current.get(tabKey) !== buffer) return false;
          if (result.kind === "conflict") {
            const message = t("workspaceEditor.conflictMessage");
            updateTab(tabKey, (current) => ({ ...current, status: "conflict", error: message }));
            setGlobalError(message);
            return false;
          }
          buffer.savedVersionId = savedVersionId;
          const dirty = model.getAlternativeVersionId() !== savedVersionId;
          updateTab(tabKey, (current) => ({
            ...current,
            dirty,
            mtimeMs: result.mtimeMs,
            contentHash: result.contentHash,
            sizeBytes: result.sizeBytes,
            status: "ready",
            error: null,
          }));
          setGlobalError(null);
          // Callers may only close/reload when the saved snapshot is still current.
          return !dirty;
        } catch (error) {
          if (!mountedRef.current || buffersRef.current.get(tabKey) !== buffer) return false;
          const message = toMessage(error, t("workspaceEditor.saveFailed"));
          updateTab(tabKey, (current) => ({ ...current, status: "ready", error: message }));
          setGlobalError(message);
          return false;
        } finally {
          buffer.savePromise = null;
        }
      })();
      buffer.savePromise = operation;
      return operation;
    },
    [ioForSource, t, tabNeedsSave, updateTab],
  );

  const readTab = useCallback(
    async (request: WorkspaceCodeEditorOpenRequest) => {
      const key = editorTabKey(request.projectPathKey, request.path, request.remote);
      const existing = tabsRef.current.find((tab) => tab.key === key);
      if (existing) {
        setActiveKey(key);
        setGlobalError(null);
        return;
      }

      const pending = openReadsRef.current.get(key);
      if (pending) {
        pending.request = request;
        return;
      }
      const read = { request };
      openReadsRef.current.set(key, read);
      const isCurrent = () =>
        mountedRef.current &&
        isOpenRef.current &&
        openRequestIdRef.current === read.request.id &&
        openReadsRef.current.get(key) === read;
      setOpeningPaths((current) => [...current, key]);
      setGlobalError(null);
      try {
        const io = ioForSource(request.projectPathKey, request.remote);
        const response = await io.read({
          workdir: request.workdir,
          path: request.path,
        });
        if (!mountedRef.current || !isOpenRef.current || openReadsRef.current.get(key) !== read)
          return;
        buffersRef.current.set(key, {
          initialContent: response.content,
          savedVersionId: null,
          lightweight: needsLightweightEditor(
            response.content,
            response.sizeBytes,
            response.totalLines,
          ),
          savePromise: null,
          reloadToken: null,
        });
        const nextTab: EditorTab = {
          key,
          projectPathKey: request.projectPathKey,
          workdir: request.workdir,
          path: response.path,
          dirty: false,
          mtimeMs: response.mtimeMs,
          contentHash: response.contentHash,
          sizeBytes: response.sizeBytes,
          totalLines: response.totalLines,
          language: monaco.languageForPath(response.path),
          status: "ready",
          error: null,
          remote: request.remote,
        };
        setEditorTabs((current) => [...current, nextTab]);
        if (isCurrent()) setActiveKey(key);
      } catch (error) {
        if (isCurrent()) {
          if (isEditorFileTooLarge(error)) {
            onPreviewFile({ ...read.request, textRange: true });
          } else {
            setGlobalError(toMessage(error, t("workspaceEditor.openFailed")));
          }
        }
      } finally {
        if (openReadsRef.current.get(key) === read) {
          openReadsRef.current.delete(key);
          setOpeningPaths((current) => current.filter((item) => item !== key));
        }
      }
    },
    [ioForSource, onPreviewFile, setEditorTabs, t],
  );

  const reloadTab = useCallback(
    async (tabKey: string) => {
      const tab = tabsRef.current.find((item) => item.key === tabKey);
      const buffer = buffersRef.current.get(tabKey);
      if (!tab || !buffer || buffer.savePromise || buffer.reloadToken) return false;
      const token = Symbol();
      buffer.reloadToken = token;
      // The monotonic ID catches edits even when they are subsequently undone.
      const startModel = modelsRef.current.get(tabKey);
      const startVersion = startModel?.getVersionId();
      setOpeningPaths((current) => [...current, tabKey]);
      updateTab(tabKey, (current) => ({ ...current, status: "reloading" }));
      setGlobalError(null);
      try {
        const io = ioForSource(tab.projectPathKey, tab.remote);
        const response = await io.read({ workdir: tab.workdir, path: tab.path });
        if (
          !mountedRef.current ||
          buffersRef.current.get(tabKey) !== buffer ||
          buffer.reloadToken !== token
        )
          return false;
        const model = modelsRef.current.get(tabKey);
        const changedDuringRead = startModel
          ? !model || model !== startModel || model.getVersionId() !== startVersion
          : model && model.getAlternativeVersionId() !== buffer.savedVersionId;
        if (changedDuringRead) {
          updateTab(tabKey, (current) => ({ ...current, status: tab.status }));
          setPendingDialog({ kind: "reloadTab", tabKey });
          return false;
        }
        buffer.lightweight = needsLightweightEditor(
          response.content,
          response.sizeBytes,
          response.totalLines,
        );
        if (model) {
          // An explicit reload resets the undo history and establishes a new baseline.
          model.setValue(response.content);
          buffer.savedVersionId = model.getAlternativeVersionId();
          buffer.initialContent = null;
        } else {
          buffer.initialContent = response.content;
        }
        updateTab(tabKey, (current) => ({
          ...current,
          path: response.path,
          dirty: false,
          mtimeMs: response.mtimeMs,
          contentHash: response.contentHash,
          sizeBytes: response.sizeBytes,
          totalLines: model
            ? model.getValueLength() === 0
              ? 0
              : model.getLineCount()
            : response.totalLines,
          language: monaco.languageForPath(response.path),
          status: "ready",
          error: null,
        }));
        return true;
      } catch (error) {
        if (!mountedRef.current || buffersRef.current.get(tabKey) !== buffer) return false;
        const message = toMessage(error, t("workspaceEditor.reloadFailed"));
        updateTab(tabKey, (current) => ({ ...current, status: tab.status, error: message }));
        setGlobalError(message);
        return false;
      } finally {
        if (buffersRef.current.get(tabKey) === buffer && buffer.reloadToken === token) {
          buffer.reloadToken = null;
          setOpeningPaths((current) => current.filter((item) => item !== tabKey));
        }
      }
    },
    [ioForSource, t, updateTab],
  );

  const closeTabNow = useCallback(
    (tabKey: string) => {
      if (buffersRef.current.get(tabKey)?.savePromise) return;
      disposeModel(tabKey);
      setOpeningPaths((current) => current.filter((item) => item !== tabKey));
      setEditorTabs((current) => {
        const index = current.findIndex((tab) => tab.key === tabKey);
        if (index < 0) return current;
        const next = current.filter((tab) => tab.key !== tabKey);
        setActiveKey((currentActive) => {
          if (currentActive !== tabKey) return currentActive;
          return next[Math.min(index, next.length - 1)]?.key ?? "";
        });
        return next;
      });
    },
    [disposeModel, setEditorTabs],
  );

  const requestCloseTab = useCallback(
    (tabKey: string) => {
      const tab = tabsRef.current.find((item) => item.key === tabKey);
      if (!tab) return;
      if (tabNeedsSave(tab)) {
        setPendingDialog({ kind: "closeTab", tabKey });
        return;
      }
      closeTabNow(tabKey);
    },
    [closeTabNow, tabNeedsSave],
  );

  const requestReloadTab = useCallback(
    (tabKey: string) => {
      const tab = tabsRef.current.find((item) => item.key === tabKey);
      if (!tab) return;
      if (
        buffersRef.current.get(tabKey)?.savePromise ||
        buffersRef.current.get(tabKey)?.reloadToken
      )
        return;
      if (tabNeedsSave(tab)) {
        setPendingDialog({ kind: "reloadTab", tabKey });
        return;
      }
      void reloadTab(tabKey);
    },
    [reloadTab, tabNeedsSave],
  );

  const requestCloseOverlay = useCallback(() => {
    if (tabsRef.current.some(tabNeedsSave)) {
      setPendingDialog({ kind: "closeOverlay" });
      return;
    }
    finishClose();
  }, [finishClose, tabNeedsSave]);

  const hideOverlay = useCallback(() => {
    if (finalCloseRequested) {
      requestCloseOverlay();
      return;
    }
    setPendingDialog(null);
    setContextMenu(null);
    finishHide();
  }, [finalCloseRequested, finishHide, requestCloseOverlay]);

  const discardDialogTarget = useCallback(() => {
    const dialog = pendingDialog;
    if (!dialog || dialogActionRef.current) return;
    const targets =
      dialog.kind === "closeOverlay"
        ? tabsRef.current
        : tabsRef.current.filter((tab) => tab.key === dialog.tabKey);
    if (targets.some((tab) => buffersRef.current.get(tab.key)?.savePromise)) return;
    setPendingDialog(null);
    if (dialog.kind === "closeOverlay") {
      finishClose(true);
      return;
    }
    if (dialog.kind === "closeTab") {
      closeTabNow(dialog.tabKey);
      return;
    }
    void reloadTab(dialog.tabKey);
  }, [closeTabNow, finishClose, pendingDialog, reloadTab]);

  const saveDialogTarget = useCallback(() => {
    const dialog = pendingDialog;
    if (!dialog || dialogActionRef.current) return;
    dialogActionRef.current = true;
    setDialogSaving(true);
    const requestId = openRequestIdRef.current;
    void (async () => {
      try {
        const targets =
          dialog.kind === "closeOverlay"
            ? tabsRef.current.filter(tabNeedsSave)
            : tabsRef.current.filter((tab) => tab.key === dialog.tabKey);
        for (const tab of targets) {
          if (!(await saveTab(tab.key))) return;
          if (openRequestIdRef.current !== requestId || !mountedRef.current) return;
        }
        // An earlier tab can be edited while a later tab is saving.
        const remaining =
          dialog.kind === "closeOverlay"
            ? tabsRef.current
            : tabsRef.current.filter((tab) => tab.key === dialog.tabKey);
        if (remaining.some(tabNeedsSave)) return;
        setPendingDialog(null);
        if (dialog.kind === "closeOverlay") finishClose();
        else if (dialog.kind === "closeTab") closeTabNow(dialog.tabKey);
        else void reloadTab(dialog.tabKey);
      } finally {
        dialogActionRef.current = false;
        if (mountedRef.current) setDialogSaving(false);
      }
    })();
  }, [closeTabNow, finishClose, pendingDialog, reloadTab, saveTab, tabNeedsSave]);

  const showFind = useCallback(() => {
    editorRef.current?.focus();
    editorRef.current?.trigger("toolbar", "actions.find", null);
  }, []);

  const showReplace = useCallback(() => {
    editorRef.current?.focus();
    editorRef.current?.trigger("toolbar", "editor.action.startFindReplaceAction", null);
  }, []);

  const runEditorCommand = useCallback((commandId: string) => {
    setContextMenu(null);
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    editor.trigger("contextMenu", commandId, null);
  }, []);

  const pasteClipboardIntoEditor = useCallback(() => {
    setContextMenu(null);
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    void readWorkspaceClipboardText().then((text) => {
      const current = editorRef.current;
      if (!current) return;
      if (text === null) {
        current.trigger("contextMenu", "editor.action.clipboardPasteAction", null);
        return;
      }
      if (!text) return;
      current.trigger("contextMenu", "paste", { text });
    });
  }, []);

  // 选区扩展到整行后作为代码引用（仅路径+行号）交给输入框；空选区退化为光标所在行。
  const insertSelectionAsCodeMention = useCallback(() => {
    setContextMenu(null);
    const editor = editorRef.current;
    const tab = activeTab;
    if (!editor || !tab || tab.remote || !onInsertCodeMention) return;
    const selection = editor.getSelection();
    if (!selection) return;
    const startLine = selection.startLineNumber;
    const endLine =
      // A selection ending at column 1 stops visually at the previous line.
      selection.endLineNumber > startLine && selection.endColumn === 1
        ? selection.endLineNumber - 1
        : selection.endLineNumber;
    const reference = createCodeMentionReference({
      path: tab.path,
      startLine,
      endLine,
    });
    if (!reference) return;
    onInsertCodeMention(reference);
  }, [activeTab, onInsertCodeMention]);

  const openEditorContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (!activeTab || pendingDialog) return;
      event.preventDefault();
      event.stopPropagation();
      editorRef.current?.focus();

      const rect = overlayRef.current?.getBoundingClientRect();
      if (!rect) return;

      setContextMenu({
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      });
    },
    [activeTab, pendingDialog],
  );

  useEffect(() => {
    if (!openRequest || openRequestIdRef.current === openRequest.id) return;
    openRequestIdRef.current = openRequest.id;
    cancelPendingClose();
    setIsVisible(true);
    void readTab(openRequest);
  }, [cancelPendingClose, openRequest, readTab]);

  useEffect(() => {
    cancelPendingClose();
    setIsVisible(isOpen);
  }, [cancelPendingClose, isOpen]);

  useEffect(() => {
    if (closeRequestId == null) return;
    if (closeRequestIdRef.current == null) {
      closeRequestIdRef.current = closeRequestId;
      return;
    }
    if (closeRequestIdRef.current === closeRequestId) return;
    closeRequestIdRef.current = closeRequestId;
    requestCloseOverlay();
  }, [closeRequestId, requestCloseOverlay]);

  useEffect(() => {
    if (finalCloseRequested) return;
    cancelPendingClose();
    if (isOpen) {
      setIsVisible(true);
    }
    setPendingDialog((current) => (current?.kind === "closeOverlay" ? null : current));
  }, [cancelPendingClose, finalCloseRequested, isOpen]);

  useEffect(() => {
    activeKeyRef.current = activeTab?.key ?? "";
  }, [activeTab?.key]);

  const hasActiveTab = activeTab !== null;
  useEffect(() => {
    const container = containerRef.current;
    if (!hasActiveTab || !container || editorRef.current) return;
    editorRef.current = monaco.editor.create(container, {
      automaticLayout: true,
      fontSize: 13,
      ...editorPerformanceOptions(false),
      largeFileOptimizations: true,
      model: null,
      contextmenu: false,
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      tabSize: 2,
      theme: theme === "dark" ? "vs-dark" : "vs",
    });
    performanceModeRef.current = false;
  }, [hasActiveTab, theme]);

  useEffect(() => {
    if (!hasActiveTab) return;
    // Keep wrapping independent of lightweight options so tab switches and edits
    // cannot reset the user's choice. These are view options; the model and its
    // undo stack stay intact. Override2 also keeps "off" effective in a11y mode.
    editorRef.current?.updateOptions({
      wordWrap: wordWrap ? "on" : "off",
      wordWrapOverride2: wordWrap ? "on" : "off",
      wrappingStrategy: "simple",
      // Monaco scans entire physical lines synchronously when wrapping. This
      // bounds rendering per view line, not wrap computation; never lift it to -1.
      stopRenderingLineAfter: LONG_EDITOR_LINE,
    });
  }, [hasActiveTab, wordWrap]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      openRequestIdRef.current = null;
      openReadsRef.current.clear();
      editorRef.current?.dispose();
      editorRef.current = null;
      for (const model of modelsRef.current.values()) model.dispose();
      modelsRef.current.clear();
      buffersRef.current.clear();
      viewStatesRef.current.clear();
    };
  }, []);

  useEffect(() => {
    monaco.editor.setTheme(theme === "dark" ? "vs-dark" : "vs");
  }, [theme]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !activeTab) {
      editorRef.current?.setModel(null);
      return;
    }

    const previousKey = editorModelKeyRef.current;
    if (previousKey && previousKey !== activeTab.key) {
      viewStatesRef.current.set(previousKey, editor.saveViewState());
    }

    const buffer = buffersRef.current.get(activeTab.key);
    if (!buffer) return;
    let model = modelsRef.current.get(activeTab.key);
    if (!model) {
      if (buffer.initialContent === null) return;
      model = monaco.editor.createModel(
        buffer.initialContent,
        buffer.lightweight ? "plaintext" : activeTab.language,
        editorModelUri(activeTab.key),
      );
      buffer.savedVersionId = model.getAlternativeVersionId();
      buffer.initialContent = null;
      const tabModel = model;
      const tabKey = activeTab.key;
      tabModel.onDidChangeContent((event) => {
        if (buffersRef.current.get(tabKey) !== buffer) return;
        const length = tabModel.getValueLength();
        const lineCount = length === 0 ? 0 : tabModel.getLineCount();
        if (!buffer.lightweight) {
          let lightweight = length >= LARGE_EDITOR_BYTES || lineCount >= LARGE_EDITOR_LINES;
          // Changes use pre-edit offsets. Translate them into the completed model
          // before inspecting changed lines (replace-all/multicursor can move them).
          const changes =
            event.changes.length > 1
              ? [...event.changes].sort((a, b) => a.rangeOffset - b.rangeOffset)
              : event.changes;
          let offsetDelta = 0;
          for (const change of changes) {
            if (lightweight) break;
            const startOffset = change.rangeOffset + offsetDelta;
            const firstLine = tabModel.getPositionAt(startOffset).lineNumber;
            const lastLine = tabModel.getPositionAt(startOffset + change.text.length).lineNumber;
            offsetDelta += change.text.length - change.rangeLength;
            for (let line = firstLine; line <= lastLine; line += 1) {
              if (tabModel.getLineLength(line) >= LONG_EDITOR_LINE) {
                lightweight = true;
                break;
              }
            }
          }
          if (lightweight) {
            buffer.lightweight = true;
            monaco.editor.setModelLanguage(tabModel, "plaintext");
            if (editorRef.current?.getModel() === tabModel) {
              editorRef.current.updateOptions(editorPerformanceOptions(true));
              performanceModeRef.current = true;
            }
          }
        }
        const dirty = tabModel.getAlternativeVersionId() !== buffer.savedVersionId;
        updateTab(tabKey, (tab) =>
          tab.dirty === dirty && tab.totalLines === lineCount && !tab.error
            ? tab
            : { ...tab, dirty, totalLines: lineCount, error: null },
        );
      });
      modelsRef.current.set(activeTab.key, model);
      updateTab(activeTab.key, (tab) => ({
        ...tab,
        totalLines: tabModel.getValueLength() === 0 ? 0 : tabModel.getLineCount(),
      }));
    }
    const language = buffer.lightweight ? "plaintext" : activeTab.language;
    if (model.getLanguageId() !== language) {
      monaco.editor.setModelLanguage(model, language);
    }
    // Updating options on attachment also restores normal features after a large tab.
    if (performanceModeRef.current !== buffer.lightweight) {
      editor.updateOptions(editorPerformanceOptions(buffer.lightweight));
      performanceModeRef.current = buffer.lightweight;
    }
    if (editor.getModel() !== model) {
      editor.setModel(model);
      const viewState = viewStatesRef.current.get(activeTab.key);
      if (viewState) {
        editor.restoreViewState(viewState);
      }
      editor.focus();
    }
    editorModelKeyRef.current = activeTab.key;
  }, [activeTab, updateTab]);

  const activeTabKey = activeTab?.key;
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !activeTabKey || !openRequest?.line) return;
    if (
      activeTabKey !==
      editorTabKey(openRequest.projectPathKey, openRequest.path, openRequest.remote)
    ) {
      return;
    }
    const locationKey = `${openRequest.id}\u0000${activeTabKey}`;
    if (linkedLocationKeyRef.current === locationKey) return;
    const model = editor.getModel();
    if (!model) return;
    const line = Math.min(Math.max(1, openRequest.line), model.getLineCount());
    const endLine = Math.min(Math.max(line, openRequest.endLine ?? line), model.getLineCount());
    const column = Math.min(Math.max(1, openRequest.column ?? 1), model.getLineMaxColumn(line));
    const endColumn = openRequest.endLine ? model.getLineMaxColumn(endLine) : column;
    const range = new monaco.Range(line, column, endLine, endColumn);
    editor.setSelection(range);
    editor.revealRangeInCenter(range);
    editor.focus();
    linkedLocationKeyRef.current = locationKey;
  }, [
    activeTabKey,
    openRequest?.column,
    openRequest?.endLine,
    openRequest?.id,
    openRequest?.line,
    openRequest?.path,
    openRequest?.projectPathKey,
    openRequest?.remote,
  ]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setContextMenu(null);
      }
      if (!isOpen) return;
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return;
      const currentKey = activeKeyRef.current;
      if (!currentKey) return;
      event.preventDefault();
      void saveTab(currentKey);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, saveTab]);

  const dialogTitle =
    pendingDialog?.kind === "closeOverlay"
      ? t("workspaceEditor.closeDirtyTitle")
      : pendingDialog?.kind === "reloadTab"
        ? t("workspaceEditor.reloadDirtyTitle")
        : t("workspaceEditor.closeTabDirtyTitle");
  const dialogDescription =
    pendingDialog?.kind === "closeOverlay"
      ? t("workspaceEditor.closeDirtyDescription")
      : pendingDialog?.kind === "reloadTab"
        ? t("workspaceEditor.reloadDirtyDescription")
        : t("workspaceEditor.closeTabDirtyDescription");

  return (
    <div
      ref={overlayRef}
      className={cn(
        "workspace-code-editor-overlay absolute inset-0 flex min-h-0 min-w-0 transform-gpu",
        "flex-col overflow-hidden border-r border-border bg-background",
        "transition-[opacity,transform,box-shadow] duration-200 ease-out motion-reduce:transition-none",
        workspaceOverlayStackClassName,
        isVisible
          ? "pointer-events-auto translate-x-0 opacity-100 shadow-2xl"
          : "pointer-events-none -translate-x-2 opacity-0 shadow-lg",
      )}
    >
      <WorkspaceOverlayTitleBar />
      <div
        className={cn(
          "flex h-11 shrink-0 items-center gap-2",
          "border-b border-border bg-muted/45 px-3",
        )}
      >
        <FilePenLine className="size-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold leading-tight">
            {t("workspaceEditor.title")}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {activeTab ? activeTab.path : t("workspaceEditor.empty")}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <IconButton
            label={t("workspaceEditor.save")}
            disabled={
              !activeTab?.dirty ||
              activeTab.status === "saving" ||
              activeTab.status === "reloading" ||
              activeTab.status === "conflict"
            }
            onClick={() => activeTab && void saveTab(activeTab.key)}
          >
            {activeTab?.status === "saving" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Save className="size-4" />
            )}
          </IconButton>
          <IconButton label={t("workspaceEditor.find")} disabled={!activeTab} onClick={showFind}>
            <Search className="size-4" />
          </IconButton>
          <IconButton
            label={t("workspaceEditor.replace")}
            disabled={!activeTab}
            onClick={showReplace}
          >
            <Replace className="size-4" />
          </IconButton>
          <IconButton
            label={t("workspaceEditor.wordWrap")}
            pressed={wordWrap}
            disabled={!activeTab}
            onClick={() => setWordWrap((current) => !current)}
          >
            <WrapText className="size-4" aria-hidden="true" />
          </IconButton>
          <RefreshButton
            variant="ghost"
            size="icon-sm"
            aria-busy={isOpening}
            className="rounded-md text-muted-foreground"
            aria-label={t("workspaceEditor.reload")}
            disabled={!activeTab || isOpening || activeTab.status === "saving"}
            onClick={() => activeTab && requestReloadTab(activeTab.key)}
          >
            <RefreshCw data-refresh-icon className={cn("size-4", isOpening && "animate-spin")} />
          </RefreshButton>
          {canPreviewActiveTab && activeTab ? (
            <IconButton
              label={t("workspaceEditor.preview")}
              onClick={() =>
                onPreviewFile({
                  id: Date.now(),
                  projectPathKey: activeTab.projectPathKey,
                  workdir: activeTab.workdir,
                  path: activeTab.path,
                  remote: activeTab.remote,
                  textRange: lightweightTab,
                })
              }
            >
              <Eye className="size-4" />
            </IconButton>
          ) : null}
          <IconButton label={t("workspaceEditor.close")} onClick={hideOverlay}>
            <X className="size-4" />
          </IconButton>
        </div>
      </div>

      <div
        className={cn(
          "flex h-10 shrink-0 items-end gap-1 overflow-x-auto",
          "border-b border-border bg-background px-2 pt-1",
        )}
      >
        {tabs.map((tab) => {
          const dirty = tab.dirty;
          return (
            <div
              key={tab.key}
              className={cn(
                "group flex h-8 max-w-56 shrink-0 items-center gap-1.5",
                "rounded-t-md border border-b-0 px-2 text-xs transition-colors",
                tab.key === activeKey
                  ? "border-border bg-muted text-foreground"
                  : "border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
              title={tab.remote ? `${t("workspaceEditor.remoteTabBadge")} · ${tab.path}` : tab.path}
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-1.5"
                onClick={() => setActiveKey(tab.key)}
              >
                {tab.status === "conflict" ? (
                  <AlertTriangle className="size-3.5 shrink-0 text-warning" />
                ) : tab.remote ? (
                  <Cloud className="size-3.5 shrink-0 text-info" />
                ) : (
                  <FilePenLine className="size-3.5 shrink-0" />
                )}
                <span className="min-w-0 truncate">{basename(tab.path)}</span>
                {dirty ? <span className="size-1.5 shrink-0 rounded-full bg-primary" /> : null}
              </button>
              <button
                type="button"
                className={cn(
                  "ml-0.5 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground/75",
                  "hover:bg-background hover:text-foreground",
                )}
                title={t("workspaceEditor.closeTab")}
                onClick={(event) => {
                  event.stopPropagation();
                  requestCloseTab(tab.key);
                }}
              >
                <X className="size-3" />
              </button>
            </div>
          );
        })}
      </div>

      {globalError || activeTab?.error ? (
        <div
          className={cn(
            "flex shrink-0 items-center gap-2",
            "border-b border-warning/20 bg-warning/10 px-3 py-2 text-xs text-warning",
          )}
        >
          <AlertTriangle className="size-4 shrink-0" />
          <div className="min-w-0 flex-1 truncate">{activeTab?.error ?? globalError}</div>
          {activeTab?.status === "conflict" ? (
            <RefreshButton
              variant="ghost"
              size="sm"
              aria-busy={isOpening}
              type="button"
              className="rounded border border-warning/30 px-2 py-1 text-xs font-medium hover:bg-warning/10"
              onClick={() => requestReloadTab(activeTab.key)}
            >
              <RefreshCw data-refresh-icon className="size-3.5" />
              {t("workspaceEditor.reloadFromDisk")}
            </RefreshButton>
          ) : null}
        </div>
      ) : null}

      {/* biome-ignore lint/a11y/noStaticElementInteractions: The editor surface exposes a pointer context menu; Monaco owns its keyboard interaction model. */}
      <div className="relative min-h-0 flex-1 bg-background" onContextMenu={openEditorContextMenu}>
        <div ref={containerRef} className={cn("absolute inset-0", !activeTab && "hidden")} />
        {!activeTab ? (
          <EmptyState variant="workspace">
            {isOpening ? (
              <Loader2 className="size-5 animate-spin" />
            ) : (
              <FilePenLine className="size-6" />
            )}
            <div>{isOpening ? t("workspaceEditor.opening") : t("workspaceEditor.emptyHint")}</div>
            {globalError ? (
              <div
                className={cn(
                  "max-w-md rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2",
                  "text-xs text-destructive",
                )}
              >
                {globalError}
              </div>
            ) : null}
          </EmptyState>
        ) : null}
      </div>

      {contextMenu ? (
        <ContextMenuPopup
          point={contextMenu}
          coordinateRoot={overlayRef}
          onClose={() => setContextMenu(null)}
          finalFocus={() => {
            editorRef.current?.focus();
            return false;
          }}
          className="w-220px"
        >
          <ContextMenuItem
            icon={Undo2}
            label={t("workspaceEditor.context.undo")}
            shortcut={contextMenuShortcuts.undo}
            onClick={() => runEditorCommand("undo")}
          />
          <ContextMenuItem
            icon={Redo2}
            label={t("workspaceEditor.context.redo")}
            shortcut={contextMenuShortcuts.redo}
            onClick={() => runEditorCommand("redo")}
          />
          <ContextMenuSeparator />
          <ContextMenuItem
            icon={Scissors}
            label={t("workspaceEditor.context.cut")}
            shortcut={contextMenuShortcuts.cut}
            onClick={() => runEditorCommand("editor.action.clipboardCutAction")}
          />
          <ContextMenuItem
            icon={Copy}
            label={t("workspaceEditor.context.copy")}
            shortcut={contextMenuShortcuts.copy}
            onClick={() => runEditorCommand("editor.action.clipboardCopyAction")}
          />
          <ContextMenuItem
            icon={ClipboardPaste}
            label={t("workspaceEditor.context.paste")}
            shortcut={contextMenuShortcuts.paste}
            onClick={pasteClipboardIntoEditor}
          />
          <ContextMenuSeparator />
          <ContextMenuItem
            icon={TextSelect}
            label={t("workspaceEditor.context.selectAll")}
            shortcut={contextMenuShortcuts.selectAll}
            onClick={() => runEditorCommand("editor.action.selectAll")}
          />
          {onInsertCodeMention && !activeTab?.remote ? (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                icon={MessageSquareText}
                label={t("workspaceEditor.context.insertCodeMention")}
                onClick={insertSelectionAsCodeMention}
              />
            </>
          ) : null}
          <ContextMenuSeparator />
          <ContextMenuItem
            icon={Search}
            label={t("workspaceEditor.find")}
            shortcut={contextMenuShortcuts.find}
            onClick={() => {
              setContextMenu(null);
              showFind();
            }}
          />
          <ContextMenuItem
            icon={Replace}
            label={t("workspaceEditor.replace")}
            shortcut={contextMenuShortcuts.replace}
            onClick={() => {
              setContextMenu(null);
              showReplace();
            }}
          />
        </ContextMenuPopup>
      ) : null}

      <div
        className={cn(
          "flex h-7 shrink-0 items-center gap-3",
          "border-t border-border bg-muted/45 px-3 text-xs text-muted-foreground",
        )}
      >
        <span className="truncate">
          {activeTab ? dirname(activeTab.path) || "/" : t("workspaceEditor.noFile")}
        </span>
        <span className="ml-auto shrink-0">
          {activeTab
            ? `${activeTab.remote ? `${t("workspaceEditor.remoteTabBadge")} · ` : ""}${activeTab.language} · ${activeTab.totalLines} ${t("workspaceEditor.lines")} · ${formatBytes(activeTab.sizeBytes)}`
            : ""}
        </span>
        {lightweightTab ? (
          <span className="min-w-0 truncate" title={t("workspaceEditor.largeFileModeDetails")}>
            {t("workspaceEditor.largeFileMode")}
          </span>
        ) : null}
        {activeTab?.dirty ? (
          <span className="shrink-0 text-primary">{t("workspaceEditor.unsaved")}</span>
        ) : null}
      </div>

      <AlertDialog
        open={pendingDialog !== null}
        onOpenChange={(open) => {
          if (!open && !dialogActionRef.current) setPendingDialog(null);
        }}
      >
        <AlertDialogContent className="max-w-md p-0">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-sm">{dialogTitle}</AlertDialogTitle>
            <AlertDialogDescription className="leading-5">
              {dialogDescription}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogActions className="max-sm:grid-cols-1">
              <Button
                type="button"
                variant="outline"
                disabled={dialogSaving}
                onClick={() => setPendingDialog(null)}
              >
                {t("workspaceEditor.cancel")}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={dialogSaving}
                onClick={discardDialogTarget}
              >
                {t("workspaceEditor.discard")}
              </Button>
              <Button
                type="button"
                disabled={dialogSaving}
                aria-busy={dialogSaving}
                onClick={saveDialogTarget}
              >
                {pendingDialog?.kind === "closeOverlay"
                  ? t("workspaceEditor.saveAll")
                  : t("workspaceEditor.save")}
              </Button>
            </AlertDialogActions>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ContextMenuItem(props: {
  icon?: IconComponent;
  label: string;
  shortcut?: string;
  onClick: () => void;
}) {
  const Icon = props.icon;
  return (
    <StandardContextMenuItem onClick={props.onClick}>
      {Icon ? (
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <span className="size-3.5 shrink-0" />
      )}
      <span className="min-w-0 flex-1 truncate">{props.label}</span>
      {props.shortcut ? (
        <KbdShortcut
          compact
          shortcut={props.shortcut}
          variant="plain"
          size="inline"
          className="text-xs tracking-wide text-muted-foreground/60"
        />
      ) : null}
    </StandardContextMenuItem>
  );
}

function ContextMenuSeparator() {
  return <hr className="mx-1 my-1 h-px border-0 bg-border/60" />;
}

function IconButton(props: {
  label: string;
  disabled?: boolean;
  pressed?: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  const { label, disabled = false, pressed, children, onClick } = props;
  return (
    <button
      type="button"
      className={cn(
        "flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors",
        "hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        pressed && "bg-muted text-foreground",
      )}
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
