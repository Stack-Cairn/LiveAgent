// Inline Monaco editor for the right-dock notes panel. Single-file, markdown
// language, autosave with explicit save/reload. Keep-alive friendly: layout
// when the dock tab becomes active again.
//
// MIRROR NOTICE: keep byte-identical with crates/agent-gateway/web/src.

import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useLocale } from "../../../i18n";
import { cn } from "../../../lib/shared/utils";
import { invokeFs, isFsBackendError } from "../../../lib/tools/fsBackend";
import { Loader2, RefreshCw, Save } from "../../icons";
import { Button } from "../../ui/button";

type MonacoEnvironmentGlobal = typeof globalThis & {
  MonacoEnvironment?: {
    getWorker: (workerId: string, label: string) => Worker;
  };
};

const monacoGlobal = globalThis as MonacoEnvironmentGlobal;
if (!monacoGlobal.MonacoEnvironment) {
  monacoGlobal.MonacoEnvironment = {
    getWorker() {
      return new EditorWorker();
    },
  };
}

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

const AUTOSAVE_MS = 700;

function toMessage(error: unknown, fallback: string) {
  if (isFsBackendError(error)) return error.message || fallback;
  if (error instanceof Error) return error.message || fallback;
  const text = String(error ?? "");
  return text || fallback;
}

function languageForPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".mdx") || lower.endsWith(".markdown")) {
    return "markdown";
  }
  return "plaintext";
}

export type NotesEditorProps = {
  active: boolean;
  notesRoot: string;
  path: string;
  theme: "light" | "dark";
  onSaved?: (path: string) => void;
};

export function NotesEditor(props: NotesEditorProps) {
  const { active, notesRoot, path, theme, onSaved } = props;
  const { t } = useLocale();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelRef = useRef<monaco.editor.ITextModel | null>(null);
  const pathRef = useRef(path);
  const metaRef = useRef({ mtimeMs: 0, contentHash: "", savedContent: "" });
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const autosaveTimerRef = useRef<number | null>(null);

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [basename, setBasename] = useState(() => path.split(/[\\/]/).pop() || path);

  pathRef.current = path;

  const clearAutosave = useCallback(() => {
    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
  }, []);

  const saveCurrent = useCallback(async () => {
    const editor = editorRef.current;
    const currentPath = pathRef.current;
    if (!editor || !currentPath || savingRef.current) return false;
    const content = editor.getValue();
    if (content === metaRef.current.savedContent) {
      dirtyRef.current = false;
      setDirty(false);
      return true;
    }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const response = await invokeFs<WriteTextResponse>("fs_write_text", {
        workdir: notesRoot,
        path: currentPath,
        content,
        mode: "rewrite",
        expected_mtime_ms: metaRef.current.mtimeMs,
        expected_content_hash: metaRef.current.contentHash,
      });
      metaRef.current = {
        mtimeMs: response.mtimeMs,
        contentHash: response.contentHash,
        savedContent: content,
      };
      dirtyRef.current = false;
      setDirty(false);
      onSaved?.(currentPath);
      return true;
    } catch (err) {
      setError(toMessage(err, t("projectTools.notes.saveFailed")));
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [notesRoot, onSaved, t]);

  const scheduleAutosave = useCallback(() => {
    clearAutosave();
    autosaveTimerRef.current = window.setTimeout(() => {
      autosaveTimerRef.current = null;
      void saveCurrent();
    }, AUTOSAVE_MS);
  }, [clearAutosave, saveCurrent]);

  const loadPath = useCallback(
    async (nextPath: string) => {
      clearAutosave();
      setLoading(true);
      setError(null);
      setBasename(nextPath.split(/[\\/]/).pop() || nextPath);
      try {
        const response = await invokeFs<ReadEditableTextResponse>("fs_read_editable_text", {
          workdir: notesRoot,
          path: nextPath,
        });
        metaRef.current = {
          mtimeMs: response.mtimeMs,
          contentHash: response.contentHash,
          savedContent: response.content,
        };
        dirtyRef.current = false;
        setDirty(false);

        const language = languageForPath(nextPath);
        const uri = monaco.Uri.from({
          scheme: "liveagent-notes",
          authority: "model",
          path: `/${encodeURIComponent(nextPath)}`,
        });
        let model = monaco.editor.getModel(uri);
        if (!model) {
          model = monaco.editor.createModel(response.content, language, uri);
        } else {
          if (model.getValue() !== response.content) {
            model.setValue(response.content);
          }
          monaco.editor.setModelLanguage(model, language);
        }
        modelRef.current = model;
        if (editorRef.current) {
          editorRef.current.setModel(model);
          editorRef.current.focus();
        }
      } catch (err) {
        setError(toMessage(err, t("projectTools.notes.loadFailed")));
      } finally {
        setLoading(false);
      }
    },
    [clearAutosave, notesRoot, t],
  );

  // Create editor once.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || editorRef.current) return;
    const editor = monaco.editor.create(container, {
      automaticLayout: true,
      fontSize: 13,
      lineHeight: 20,
      minimap: { enabled: false },
      wordWrap: "on",
      scrollBeyondLastLine: false,
      renderLineHighlight: "line",
      padding: { top: 8, bottom: 8 },
      theme: theme === "dark" ? "vs-dark" : "vs",
      tabSize: 2,
    });
    editorRef.current = editor;
    const disposable = editor.onDidChangeModelContent(() => {
      const value = editor.getValue();
      const nextDirty = value !== metaRef.current.savedContent;
      if (nextDirty !== dirtyRef.current) {
        dirtyRef.current = nextDirty;
        setDirty(nextDirty);
      }
      if (nextDirty) scheduleAutosave();
    });
    return () => {
      disposable.dispose();
      clearAutosave();
      editor.dispose();
      editorRef.current = null;
      if (modelRef.current) {
        modelRef.current.dispose();
        modelRef.current = null;
      }
    };
  }, [clearAutosave, scheduleAutosave, theme]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    monaco.editor.setTheme(theme === "dark" ? "vs-dark" : "vs");
  }, [theme]);

  useEffect(() => {
    if (!path) return;
    void loadPath(path);
  }, [loadPath, path]);

  useEffect(() => {
    if (!active) return;
    const editor = editorRef.current;
    if (!editor) return;
    // Keep-alive tabs stay mounted behind `hidden`; re-layout when shown.
    const frame = window.requestAnimationFrame(() => {
      editor.layout();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!active) return;
      const isSave =
        (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s" && !event.shiftKey;
      if (!isSave) return;
      event.preventDefault();
      clearAutosave();
      void saveCurrent();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, clearAutosave, saveCurrent]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/70 px-2">
        <div className="min-w-0 flex-1 truncate text-xs text-foreground" title={path}>
          {basename}
          {dirty ? <span className="ml-1 text-amber-500">•</span> : null}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 rounded-md"
          title={t("projectTools.notes.reload")}
          disabled={loading || saving}
          onClick={() => void loadPath(path)}
        >
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 rounded-md"
          title={t("projectTools.notes.save")}
          disabled={!dirty || loading || saving}
          onClick={() => {
            clearAutosave();
            void saveCurrent();
          }}
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
        </Button>
      </div>
      {error ? (
        <div className="shrink-0 border-b border-destructive/20 bg-destructive/10 px-3 py-1.5 text-[11px] text-destructive">
          {error}
        </div>
      ) : null}
      <div className="relative min-h-0 flex-1">
        <div ref={containerRef} className="absolute inset-0" />
        {loading ? (
          <div className="absolute inset-0 flex items-center justify-center bg-background/50">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : null}
      </div>
    </div>
  );
}
