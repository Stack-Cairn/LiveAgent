// `fs_mention_list` for hosts without the native command (the K-brain browser
// host). K-brain has no mention index yet, so this builds one from its generic
// `/v1/fs` "list" walk and applies the native command's filtering and ranking
// (src-tauri commands/workspace/fs.rs `fs_mention_list_sync`). The walk does
// not read .gitignore and fails past 10000 entries, so deep trees fall back to
// shallower depths and report `truncated`.

export type KBrainFsListEntry = { path: string; kind: string; hidden?: boolean };
export type KBrainFsListResponse = { entries?: KBrainFsListEntry[]; has_more?: boolean };
export type KBrainFsListRequest = {
  action: "list";
  workdir: string;
  path: string;
  depth: number;
  max_results: number;
  show_hidden: boolean;
};
export type FileMentionListResult = {
  entries: Array<{ path: string; kind: "file" | "dir"; hidden: boolean }>;
  truncated: boolean;
};

/** Directory names the native mention index never descends into. */
const IGNORED_DIR_NAMES = new Set(
  [
    ".cache",
    ".gradle",
    ".hg",
    ".idea",
    ".next",
    ".nox",
    ".nuxt",
    ".parcel-cache",
    ".pnpm-store",
    ".pytest_cache",
    ".ruff_cache",
    ".sass-cache",
    ".serverless",
    ".svn",
    ".svelte-kit",
    ".tox",
    ".turbo",
    ".venv",
    ".vite",
    ".webpack",
    ".yarn",
    "__pycache__",
    "bin",
    "bower_components",
    "build",
    "cmakefiles",
    "coverage",
    "deriveddata",
    "dist",
    "dist-ssr",
    "env",
    "gradle",
    "htmlcov",
    "node_modules",
    "obj",
    "out",
    "pods",
    "target",
    "venv",
    "vendor",
  ].map((name) => name.toLowerCase()),
);

/** Walk depths tried in order; K-brain rejects a walk over 10000 entries. */
const LIST_DEPTHS = [8, 4, 2, 1];
const LIST_MAX_RESULTS = 10000;
const DEFAULT_MAX_RESULTS = 5000;

function isIgnoredSegment(segment: string) {
  const name = segment.toLowerCase();
  return IGNORED_DIR_NAMES.has(name) || name.startsWith("cmake-build-");
}

function normalizeFileMentionQuery(query: unknown) {
  return typeof query === "string"
    ? query.trim().replace(/^@+/, "").replace(/\\/g, "/").toLowerCase()
    : "";
}

function sortKey(path: string, kind: string, query: string): [number, number, number, string] {
  const lower = path.toLowerCase();
  const name = lower.slice(lower.lastIndexOf("/") + 1);
  const matchRank =
    !query || name.startsWith(query)
      ? 0
      : lower.startsWith(query)
        ? 1
        : name.includes(query)
          ? 2
          : 3;
  return [matchRank, lower.split("/").length - 1, kind === "dir" ? 0 : 1, lower];
}

function compareKeys(a: [number, number, number, string], b: [number, number, number, string]) {
  for (let i = 0; i < 3; i++) {
    const diff = (a[i] as number) - (b[i] as number);
    if (diff !== 0) return diff;
  }
  return a[3] < b[3] ? -1 : a[3] > b[3] ? 1 : 0;
}

/** Filter and rank a raw K-brain listing like the native mention index. */
export function rankFileMentions(
  raw: readonly KBrainFsListEntry[],
  query: string,
  maxResults: number,
): FileMentionListResult {
  const keyed = raw
    .filter((entry) => {
      const path = entry.path.replace(/^\.\//, "");
      if (!path || path.split("/").some(isIgnoredSegment)) return false;
      return !query || path.toLowerCase().includes(query);
    })
    .map((entry) => {
      const path = entry.path.replace(/^\.\//, "");
      const kind: "file" | "dir" = entry.kind === "dir" ? "dir" : "file";
      return {
        entry: { path, kind, hidden: entry.hidden === true },
        key: sortKey(path, kind, query),
      };
    })
    .sort((a, b) => compareKeys(a.key, b.key));
  const limit = Math.max(1, maxResults);
  return {
    entries: keyed.slice(0, limit).map((item) => item.entry),
    truncated: keyed.length > limit,
  };
}

function isTreeTooLarge(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /exceeds \d+ entries/i.test(message);
}

export async function listFileMentionsViaFsList(
  list: (request: KBrainFsListRequest) => Promise<KBrainFsListResponse>,
  args: Record<string, unknown> | undefined,
): Promise<FileMentionListResult> {
  const workdir = typeof args?.workdir === "string" ? args.workdir.trim() : "";
  if (!workdir) throw new Error("workdir is required");
  const maxResults =
    typeof args?.max_results === "number" && args.max_results > 0
      ? args.max_results
      : DEFAULT_MAX_RESULTS;
  const query = normalizeFileMentionQuery(args?.query);
  let lastError: unknown;
  for (const [index, depth] of LIST_DEPTHS.entries()) {
    try {
      const response = await list({
        action: "list",
        workdir,
        path: "",
        depth,
        max_results: LIST_MAX_RESULTS,
        show_hidden: args?.show_hidden === true,
      });
      const ranked = rankFileMentions(response.entries ?? [], query, maxResults);
      return {
        entries: ranked.entries,
        truncated: ranked.truncated || index > 0 || response.has_more === true,
      };
    } catch (error) {
      if (!isTreeTooLarge(error)) throw error;
      lastError = error;
    }
  }
  throw lastError;
}
