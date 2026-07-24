import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import CssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import TsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import {
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLocale } from "../../i18n";
import {
  type CodeMentionReference,
  createCodeMentionReference,
} from "../../lib/chat/messages/mentionReferences";
import { cn } from "../../lib/shared/utils";
import { readClipboardText } from "../../lib/system/clipboardText";
import { invokeFs, isFsBackendError } from "../../lib/tools/fsBackend";
import type { IconComponent } from "../icons";
import {
  AlertTriangle,
  ClipboardPaste,
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
  X,
} from "../icons";
import { MacOsTitleBarSpacer } from "../MacOsTitleBarSpacer";
import { isWorkspacePreviewPath } from "./workspaceImagePreview";

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
};

type ReadEditableTextResponse = {
  path: string;
  content: string;
  mtimeMs: number;
  contentHash: string;
  sizeBytes: number;
  totalLines: number;
};

type WriteTextResponse = {
  path: string;
  mtimeMs: number;
  contentHash: string;
  totalLines: number;
};

type EditorTabStatus = "ready" | "saving" | "conflict";

type EditorTab = {
  key: string;
  projectPathKey: string;
  workdir: string;
  path: string;
  content: string;
  savedContent: string;
  mtimeMs: number;
  contentHash: string;
  sizeBytes: number;
  totalLines: number;
  language: string;
  status: EditorTabStatus;
  error: string | null;
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
const EDITOR_CONTEXT_MENU_WIDTH = 220;
const EDITOR_CONTEXT_MENU_HEIGHT = 340;

type WorkspaceCodeEditorOverlayProps = {
  openRequest: WorkspaceCodeEditorOpenRequest | null;
  closeRequestId?: number;
  isOpen: boolean;
  finalCloseRequested?: boolean;
  theme: "light" | "dark";
  onPreviewFile: (request: WorkspaceCodeEditorOpenRequest) => void;
  onInsertCodeMention?: (reference: CodeMentionReference) => void;
  onHide: () => void;
  onClose: () => void;
};

function editorTabKey(projectPathKey: string, path: string) {
  return `${projectPathKey}\u0000${path}`;
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

function languageForPath(path: string) {
  const name = basename(path).toLowerCase();
  if (name === "dockerfile") return "dockerfile";
  if (name === "makefile") return "makefile";
  if (name === "cargo.lock") return "toml";
  if (name.endsWith(".d.ts")) return "typescript";

  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  switch (ext) {
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "javascript";
    case "ts":
    case "tsx":
      return "typescript";
    case "json":
    case "jsonc":
      return "json";
    case "css":
      return "css";
    case "scss":
    case "sass":
      return "scss";
    case "less":
      return "less";
    case "html":
    case "htm":
      return "html";
    case "md":
    case "mdx":
      return "markdown";
    case "rs":
      return "rust";
    case "go":
      return "go";
    case "py":
      return "python";
    case "java":
      return "java";
    case "kt":
    case "kts":
      return "kotlin";
    case "c":
    case "h":
      return "c";
    case "cc":
    case "cpp":
    case "cxx":
    case "hpp":
      return "cpp";
    case "cs":
      return "csharp";
    case "php":
      return "php";
    case "rb":
      return "ruby";
    case "swift":
      return "swift";
    case "sh":
    case "bash":
    case "zsh":
      return "shell";
    case "yml":
    case "yaml":
      return "yaml";
    case "toml":
      return "toml";
    case "xml":
    case "svg":
      return "xml";
    case "sql":
      return "sql";
    case "graphql":
    case "gql":
      return "graphql";
    default:
      return "plaintext";
  }
}

function isVersionConflict(error: unknown) {
  if (isFsBackendError(error) && error.code === "stale_file") return true;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.includes("File changed since the last full Read");
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

function isMacLikePlatform() {
  if (typeof navigator === "undefined") return false;
  const platform = `${navigator.userAgent} ${navigator.platform}`;
  return /Mac|iPhone|iPad|iPod/i.test(platform);
}

function getEditorContextMenuShortcuts() {
  const isMac = isMacLikePlatform();
  return {
    undo: isMac ? "⌘Z" : "Ctrl+Z",
    redo: isMac ? "⌘⇧Z" : "Ctrl+Y",
    cut: isMac ? "⌘X" : "Ctrl+X",
    copy: isMac ? "⌘C" : "Ctrl+C",
    paste: isMac ? "⌘V" : "Ctrl+V",
    selectAll: isMac ? "⌘A" : "Ctrl+A",
    find: isMac ? "⌘F" : "Ctrl+F",
    replace: isMac ? "⌥⌘F" : "Ctrl+H",
  } as const;
}

export function WorkspaceCodeEditorOverlay(props: WorkspaceCodeEditorOverlayProps) {
  const {
    openRequest,
    closeRequestId,
    isOpen,
    finalCloseRequested = false,
    theme,
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
  const viewStatesRef = useRef(new Map<string, monaco.editor.ICodeEditorViewState | null>());
  const editorModelKeyRef = useRef("");
  const activeKeyRef = useRef("");
  const openRequestIdRef = useRef<number | null>(null);
  const closeRequestIdRef = useRef<number | null>(null);
  const openAnimationFrameRef = useRef<number | null>(null);
  const closeAnimationTimeoutRef = useRef<number | null>(null);
  const initialThemeRef = useRef(theme);
  const [tabs, setTabs] = useState<EditorTab[]>([]);
  const [activeKey, setActiveKey] = useState("");
  const [openingPaths, setOpeningPaths] = useState<string[]>([]);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [pendingDialog, setPendingDialog] = useState<PendingDialog | null>(null);
  const [contextMenu, setContextMenu] = useState<EditorContextMenuState | null>(null);
  const [isVisible, setIsVisible] = useState(false);

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.key === activeKey) ?? tabs[0] ?? null,
    [activeKey, tabs],
  );
  const canPreviewActiveTab = Boolean(activeTab && isWorkspacePreviewPath(activeTab.path));
  const dirtyTabs = useMemo(() => tabs.filter((tab) => tab.content !== tab.savedContent), [tabs]);
  const hasDirtyTabs = dirtyTabs.length > 0;
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

  const finishClose = useCallback(() => {
    if (closeAnimationTimeoutRef.current !== null) {
      window.clearTimeout(closeAnimationTimeoutRef.current);
      closeAnimationTimeoutRef.current = null;
    }
    setIsVisible(false);
    closeAnimationTimeoutRef.current = window.setTimeout(() => {
      closeAnimationTimeoutRef.current = null;
      onClose();
    }, EDITOR_OVERLAY_ANIMATION_MS);
  }, [onClose]);

  const updateTab = useCallback((tabKey: string, updater: (tab: EditorTab) => EditorTab) => {
    setTabs((current) => current.map((tab) => (tab.key === tabKey ? updater(tab) : tab)));
  }, []);

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
  }, []);

  const saveTab = useCallback(
    async (tabKey: string) => {
      const tab = tabs.find((item) => item.key === tabKey);
      if (!tab || tab.content === tab.savedContent || tab.status === "saving") return true;
      if (tab.status === "conflict") {
        const message = tab.error ?? t("workspaceEditor.conflictMessage");
        setGlobalError(message);
        return false;
      }

      const contentToSave = tab.content;
      updateTab(tabKey, (current) => ({ ...current, status: "saving", error: null }));
      try {
        const response = await invokeFs<WriteTextResponse>("fs_write_text", {
          workdir: tab.workdir,
          path: tab.path,
          content: contentToSave,
          mode: "rewrite",
          expected_mtime_ms: tab.mtimeMs,
          expected_content_hash: tab.contentHash,
        });
        updateTab(tabKey, (current) => ({
          ...current,
          savedContent: contentToSave,
          mtimeMs: response.mtimeMs,
          contentHash: response.contentHash,
          totalLines: current.content === contentToSave ? response.totalLines : current.totalLines,
          sizeBytes: new TextEncoder().encode(current.content).length,
          status: "ready",
          error: null,
        }));
        setGlobalError(null);
        return true;
      } catch (error) {
        const conflict = isVersionConflict(error);
        const message = conflict
          ? t("workspaceEditor.conflictMessage")
          : toMessage(error, t("workspaceEditor.saveFailed"));
        updateTab(tabKey, (current) => ({
          ...current,
          status: conflict ? "conflict" : "ready",
          error: message,
        }));
        setGlobalError(message);
        return false;
      }
    },
    [t, tabs, updateTab],
  );

  const readTab = useCallback(
    async (request: WorkspaceCodeEditorOpenRequest) => {
      const key = editorTabKey(request.projectPathKey, request.path);
      const existing = tabs.find((tab) => tab.key === key);
      if (existing) {
        setActiveKey(key);
        setGlobalError(null);
        return;
      }

      setOpeningPaths((current) => [
        ...current.filter((item) => item !== request.path),
        request.path,
      ]);
      setGlobalError(null);
      try {
        const response = await invokeFs<ReadEditableTextResponse>("fs_read_editable_text", {
          workdir: request.workdir,
          path: request.path,
        });
        const nextTab: EditorTab = {
          key,
          projectPathKey: request.projectPathKey,
          workdir: request.workdir,
          path: response.path,
          content: response.content,
          savedContent: response.content,
          mtimeMs: response.mtimeMs,
          contentHash: response.contentHash,
          sizeBytes: response.sizeBytes,
          totalLines: response.totalLines,
          language: languageForPath(response.path),
          status: "ready",
          error: null,
        };
        setTabs((current) => {
          if (current.some((tab) => tab.key === key)) return current;
          return [...current, nextTab];
        });
        setActiveKey(key);
      } catch (error) {
        setGlobalError(toMessage(error, t("workspaceEditor.openFailed")));
      } finally {
        setOpeningPaths((current) => current.filter((item) => item !== request.path));
      }
    },
    [t, tabs],
  );

  const reloadTab = useCallback(
    async (tabKey: string) => {
      const tab = tabs.find((item) => item.key === tabKey);
      if (!tab) return false;
      setOpeningPaths((current) => [...current.filter((item) => item !== tab.path), tab.path]);
      setGlobalError(null);
      try {
        const response = await invokeFs<ReadEditableTextResponse>("fs_read_editable_text", {
          workdir: tab.workdir,
          path: tab.path,
        });
        const model = modelsRef.current.get(tabKey);
        if (model && model.getValue() !== response.content) {
          model.setValue(response.content);
        }
        updateTab(tabKey, (current) => ({
          ...current,
          path: response.path,
          content: response.content,
          savedContent: response.content,
          mtimeMs: response.mtimeMs,
          contentHash: response.contentHash,
          sizeBytes: response.sizeBytes,
          totalLines: response.totalLines,
          language: languageForPath(response.path),
          status: "ready",
          error: null,
        }));
        return true;
      } catch (error) {
        const message = toMessage(error, t("workspaceEditor.reloadFailed"));
        updateTab(tabKey, (current) => ({ ...current, error: message }));
        setGlobalError(message);
        return false;
      } finally {
        setOpeningPaths((current) => current.filter((item) => item !== tab.path));
      }
    },
    [t, tabs, updateTab],
  );

  const closeTabNow = useCallback(
    (tabKey: string) => {
      disposeModel(tabKey);
      setTabs((current) => {
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
    [disposeModel],
  );

  const requestCloseTab = useCallback(
    (tabKey: string) => {
      const tab = tabs.find((item) => item.key === tabKey);
      if (!tab) return;
      if (tab.content !== tab.savedContent) {
        setPendingDialog({ kind: "closeTab", tabKey });
        return;
      }
      closeTabNow(tabKey);
    },
    [closeTabNow, tabs],
  );

  const requestReloadTab = useCallback(
    (tabKey: string) => {
      const tab = tabs.find((item) => item.key === tabKey);
      if (!tab) return;
      if (tab.status !== "conflict" && tab.content !== tab.savedContent) {
        setPendingDialog({ kind: "reloadTab", tabKey });
        return;
      }
      void reloadTab(tabKey);
    },
    [reloadTab, tabs],
  );

  const requestCloseOverlay = useCallback(() => {
    if (hasDirtyTabs) {
      setPendingDialog({ kind: "closeOverlay" });
      return;
    }
    finishClose();
  }, [finishClose, hasDirtyTabs]);

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
    setPendingDialog(null);
    if (!dialog) return;
    if (dialog.kind === "closeOverlay") {
      finishClose();
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
    if (!dialog) return;
    void (async () => {
      if (dialog.kind === "closeOverlay") {
        for (const tab of dirtyTabs) {
          const saved = await saveTab(tab.key);
          if (!saved) return;
        }
        setPendingDialog(null);
        finishClose();
        return;
      }
      const saved = await saveTab(dialog.tabKey);
      if (!saved) return;
      setPendingDialog(null);
      if (dialog.kind === "closeTab") {
        closeTabNow(dialog.tabKey);
      } else {
        void reloadTab(dialog.tabKey);
      }
    })();
  }, [closeTabNow, dirtyTabs, finishClose, pendingDialog, reloadTab, saveTab]);

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

  // 粘贴不走 Monaco 的 clipboardPasteAction：它内部读 navigator.clipboard，
  // WKWebView 对外部应用复制的内容会弹出原生"粘贴"确认气泡。改为先经
  // Rust 侧读剪贴板，再把文本喂给 Monaco 的 paste 处理器。
  const pasteClipboardIntoEditor = useCallback(() => {
    setContextMenu(null);
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    void readClipboardText().then((text) => {
      const current = editorRef.current;
      if (!current) return;
      if (text === null) {
        // 两条剪贴板通道都不可用，退回 Monaco 内建粘贴兜底。
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
    if (!editor || !tab || !onInsertCodeMention) return;
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
      const maxX = Math.max(8, rect.width - EDITOR_CONTEXT_MENU_WIDTH - 8);
      const maxY = Math.max(8, rect.height - EDITOR_CONTEXT_MENU_HEIGHT - 8);
      setContextMenu({
        x: Math.min(Math.max(event.clientX - rect.left, 8), maxX),
        y: Math.min(Math.max(event.clientY - rect.top, 8), maxY),
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

  useEffect(() => {
    const container = containerRef.current;
    if (!container || editorRef.current) return;
    const editor = monaco.editor.create(container, {
      automaticLayout: true,
      fontSize: 13,
      fontLigatures: true,
      minimap: { enabled: true },
      model: null,
      contextmenu: false,
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      tabSize: 2,
      theme: initialThemeRef.current === "dark" ? "vs-dark" : "vs",
    });
    editorRef.current = editor;
    return () => {
      editor.dispose();
      editorRef.current = null;
      for (const model of modelsRef.current.values()) {
        model.dispose();
      }
      modelsRef.current.clear();
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

    let model = modelsRef.current.get(activeTab.key);
    if (!model) {
      model = monaco.editor.createModel(
        activeTab.content,
        activeTab.language,
        editorModelUri(activeTab.key),
      );
      model.onDidChangeContent(() => {
        const value = model?.getValue() ?? "";
        const lineCount = model?.getLineCount() ?? 0;
        setTabs((current) =>
          current.map((tab) =>
            tab.key === activeTab.key
              ? { ...tab, content: value, totalLines: lineCount, error: null }
              : tab,
          ),
        );
      });
      modelsRef.current.set(activeTab.key, model);
    }
    if (model.getLanguageId() !== activeTab.language) {
      monaco.editor.setModelLanguage(model, activeTab.language);
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
  }, [activeTab]);

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

  useEffect(() => {
    if (!contextMenu) return;
    const closeContextMenu = () => setContextMenu(null);
    window.addEventListener("click", closeContextMenu);
    window.addEventListener("blur", closeContextMenu);
    window.addEventListener("resize", closeContextMenu);
    return () => {
      window.removeEventListener("click", closeContextMenu);
      window.removeEventListener("blur", closeContextMenu);
      window.removeEventListener("resize", closeContextMenu);
    };
  }, [contextMenu]);

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
        "absolute inset-0 z-50 flex min-h-0 min-w-0 transform-gpu flex-col overflow-hidden border-r border-border bg-background transition-[opacity,transform,box-shadow] duration-200 ease-out motion-reduce:transition-none",
        isVisible
          ? "pointer-events-auto translate-x-0 opacity-100 shadow-2xl"
          : "pointer-events-none -translate-x-2 opacity-0 shadow-lg",
      )}
    >
      <MacOsTitleBarSpacer className="bg-muted/45" />
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-muted/45 px-3">
        <FilePenLine className="h-4 w-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold leading-tight">
            {t("workspaceEditor.title")}
          </div>
          <div className="truncate text-[11px] text-muted-foreground">
            {activeTab ? activeTab.path : t("workspaceEditor.empty")}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <IconButton
            label={t("workspaceEditor.save")}
            disabled={
              !activeTab ||
              activeTab.content === activeTab.savedContent ||
              activeTab.status === "saving" ||
              activeTab.status === "conflict"
            }
            onClick={() => activeTab && void saveTab(activeTab.key)}
          >
            {activeTab?.status === "saving" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
          </IconButton>
          <IconButton label={t("workspaceEditor.find")} disabled={!activeTab} onClick={showFind}>
            <Search className="h-4 w-4" />
          </IconButton>
          <IconButton
            label={t("workspaceEditor.replace")}
            disabled={!activeTab}
            onClick={showReplace}
          >
            <Replace className="h-4 w-4" />
          </IconButton>
          <IconButton
            label={t("workspaceEditor.reload")}
            disabled={!activeTab || isOpening}
            onClick={() => activeTab && requestReloadTab(activeTab.key)}
          >
            <RefreshCw className={cn("h-4 w-4", isOpening && "animate-spin")} />
          </IconButton>
          {canPreviewActiveTab && activeTab ? (
            <IconButton
              label={t("workspaceEditor.preview")}
              onClick={() =>
                onPreviewFile({
                  id: Date.now(),
                  projectPathKey: activeTab.projectPathKey,
                  workdir: activeTab.workdir,
                  path: activeTab.path,
                })
              }
            >
              <Eye className="h-4 w-4" />
            </IconButton>
          ) : null}
          <IconButton label={t("workspaceEditor.close")} onClick={hideOverlay}>
            <X className="h-4 w-4" />
          </IconButton>
        </div>
      </div>

      <div className="flex h-10 shrink-0 items-end gap-1 overflow-x-auto border-b border-border bg-background px-2 pt-1">
        {tabs.map((tab) => {
          const dirty = tab.content !== tab.savedContent;
          return (
            <div
              key={tab.key}
              className={cn(
                "group flex h-8 max-w-[14rem] shrink-0 items-center gap-1.5 rounded-t-md border border-b-0 px-2 text-xs transition-colors",
                tab.key === activeKey
                  ? "border-border bg-muted text-foreground"
                  : "border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
              title={tab.path}
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                onClick={() => setActiveKey(tab.key)}
              >
                {tab.status === "conflict" ? (
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                ) : (
                  <FilePenLine className="h-3.5 w-3.5 shrink-0" />
                )}
                <span className="min-w-0 truncate">{basename(tab.path)}</span>
                {dirty ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" /> : null}
              </button>
              <button
                type="button"
                className="ml-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/75 hover:bg-background hover:text-foreground"
                title={t("workspaceEditor.closeTab")}
                aria-label={t("workspaceEditor.closeTab")}
                onClick={(event) => {
                  event.stopPropagation();
                  requestCloseTab(tab.key);
                }}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          );
        })}
      </div>

      {globalError || activeTab?.error ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <div className="min-w-0 flex-1 truncate">{activeTab?.error ?? globalError}</div>
          {activeTab?.status === "conflict" ? (
            <button
              type="button"
              className="rounded border border-amber-500/30 px-2 py-1 text-[11px] font-medium hover:bg-amber-500/10"
              onClick={() => requestReloadTab(activeTab.key)}
            >
              {t("workspaceEditor.reloadFromDisk")}
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1 bg-background" onContextMenu={openEditorContextMenu}>
        <div ref={containerRef} className={cn("absolute inset-0", !activeTab && "hidden")} />
        {!activeTab ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
            {isOpening ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : (
              <FilePenLine className="h-6 w-6" />
            )}
            <div>{isOpening ? t("workspaceEditor.opening") : t("workspaceEditor.emptyHint")}</div>
            {globalError ? (
              <div className="max-w-md rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                {globalError}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {contextMenu ? (
        <div
          className="editor-context-menu absolute z-50 w-[220px] overflow-hidden rounded-xl border border-border/60 bg-popover/80 p-1 text-sm text-popover-foreground shadow-2xl ring-1 ring-black/[0.03] backdrop-blur-xl dark:ring-white/[0.06]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          role="menu"
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
          onMouseDown={(event) => event.preventDefault()}
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
          {onInsertCodeMention ? (
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
        </div>
      ) : null}

      <div className="flex h-7 shrink-0 items-center gap-3 border-t border-border bg-muted/45 px-3 text-[11px] text-muted-foreground">
        <span className="truncate">
          {activeTab ? dirname(activeTab.path) || "/" : t("workspaceEditor.noFile")}
        </span>
        <span className="ml-auto shrink-0">
          {activeTab
            ? `${activeTab.language} · ${activeTab.totalLines} ${t("workspaceEditor.lines")} · ${formatBytes(activeTab.sizeBytes)}`
            : ""}
        </span>
        {activeTab?.content !== activeTab?.savedContent ? (
          <span className="shrink-0 text-primary">{t("workspaceEditor.unsaved")}</span>
        ) : null}
      </div>

      {pendingDialog ? (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/55 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-2xl">
            <div className="text-sm font-semibold">{dialogTitle}</div>
            <div className="mt-2 text-sm leading-5 text-muted-foreground">{dialogDescription}</div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
                onClick={() => setPendingDialog(null)}
              >
                {t("workspaceEditor.cancel")}
              </button>
              <button
                type="button"
                className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
                onClick={discardDialogTarget}
              >
                {t("workspaceEditor.discard")}
              </button>
              <button
                type="button"
                className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                onClick={saveDialogTarget}
              >
                {pendingDialog.kind === "closeOverlay"
                  ? t("workspaceEditor.saveAll")
                  : t("workspaceEditor.save")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
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
    <button
      type="button"
      role="menuitem"
      className="flex h-[30px] w-full items-center gap-2.5 rounded-lg px-2 text-left text-[13px] text-popover-foreground/90 transition-colors hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground focus:outline-none"
      onClick={props.onClick}
    >
      {Icon ? (
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <span className="h-3.5 w-3.5 shrink-0" />
      )}
      <span className="min-w-0 flex-1 truncate">{props.label}</span>
      {props.shortcut ? (
        <kbd className="shrink-0 text-[11px] tracking-wide text-muted-foreground/60">
          {props.shortcut}
        </kbd>
      ) : null}
    </button>
  );
}

function ContextMenuSeparator() {
  return <hr className="mx-1 my-1 h-px border-0 bg-border/60" />;
}

function IconButton(props: {
  label: string;
  disabled?: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  const { label, disabled = false, children, onClick } = props;
  return (
    <button
      type="button"
      className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
