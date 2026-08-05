import { generateDiffFile } from "@git-diff-view/file";
import { DiffModeEnum, DiffView } from "@git-diff-view/react";
import { useMemo, useSyncExternalStore } from "react";
import "@git-diff-view/react/styles/diff-view.css";

function guessLangFromPath(filePath?: string): string {
  if (!filePath) return "txt";
  const ext = filePath.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    py: "python",
    rs: "rust",
    go: "go",
    java: "java",
    kt: "kotlin",
    rb: "ruby",
    swift: "swift",
    c: "c",
    cpp: "cpp",
    h: "c",
    hpp: "cpp",
    cs: "csharp",
    css: "css",
    scss: "scss",
    html: "html",
    vue: "vue",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    xml: "xml",
    md: "markdown",
    sql: "sql",
    sh: "bash",
    zsh: "bash",
    bash: "bash",
    dockerfile: "dockerfile",
    lua: "lua",
    php: "php",
    dart: "dart",
  };
  return (ext && map[ext]) || "txt";
}

// One shared MutationObserver for every mounted diff view — a transcript can
// hold dozens, and per-instance observers on <html> add up.
const darkModeListeners = new Set<() => void>();
let darkModeObserver: MutationObserver | null = null;

function subscribeToDarkMode(listener: () => void) {
  darkModeListeners.add(listener);
  if (!darkModeObserver) {
    darkModeObserver = new MutationObserver(() => {
      for (const notify of darkModeListeners) {
        notify();
      }
    });
    darkModeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
  }
  return () => {
    darkModeListeners.delete(listener);
    if (darkModeListeners.size === 0 && darkModeObserver) {
      darkModeObserver.disconnect();
      darkModeObserver = null;
    }
  };
}

function getIsDarkSnapshot() {
  return document.documentElement.classList.contains("dark");
}

function useIsDark() {
  return useSyncExternalStore(subscribeToDarkMode, getIsDarkSnapshot);
}

export function EditDiffView(props: { beforeText: string; afterText: string; filePath?: string }) {
  const { beforeText, afterText, filePath } = props;
  const isDark = useIsDark();
  const lang = guessLangFromPath(filePath);

  const diffFile = useMemo(() => {
    if (!beforeText && !afterText) return undefined;
    const instance = generateDiffFile(
      filePath ?? "old",
      beforeText,
      filePath ?? "new",
      afterText,
      lang,
      lang,
    );
    instance.init();
    instance.buildSplitDiffLines();
    return instance;
  }, [beforeText, afterText, filePath, lang]);

  if (!diffFile) return null;

  return (
    <div className="edit-tool-diff-view tool-text-scroll overflow-x-auto overflow-y-hidden rounded-[10px] border border-black/[0.06] bg-white/[0.58] shadow-sm dark:border-white/[0.08] dark:bg-white/[0.04] dark:shadow-none">
      <DiffView
        diffFile={diffFile}
        diffViewMode={DiffModeEnum.Unified}
        diffViewTheme={isDark ? "dark" : "light"}
        diffViewHighlight
        diffViewAddWidget={false}
        diffViewWrap={false}
        diffViewFontSize={12}
      />
    </div>
  );
}
