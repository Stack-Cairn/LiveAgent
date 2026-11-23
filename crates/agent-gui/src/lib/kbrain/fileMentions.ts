// `fs_mention_list` for hosts without the native command (the K-brain browser
// host). K-brain backends with capability `filesystem_mention_list` answer it
// with `/v1/fs` "mention_list": ignore rules (.gitignore, node_modules, ...),
// ranking and the walk all happen in the backend, which returns at most 500
// ranked matches. Older backends get the index built from the generic "list"
// walk with the native command's filtering and ranking (src-tauri
// commands/workspace/fs.rs `fs_mention_list_sync`); that walk does not read
// .gitignore and fails past 10000 entries, so deep trees fall back to shallower
// depths and report `truncated`.

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
export type KBrainFsMentionListRequest = {
  action: "mention_list";
  workdir: string;
  path: string;
  query: string;
  max_results: number;
};
export type KBrainFsMentionListResponse = {
  entries?: Array<{ path: string; kind: string }>;
  truncated?: boolean;
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

async function listFileMentionsViaFsList(
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

/** K-brain rejects a mention_list request for more than this many results. */
const MENTION_LIST_MAX_RESULTS = 500;
/**
 * An unfiltered request for more than this is a whole-workspace index (quick
 * open asks for 20000) rather than a mention lookup: mention_list caps its
 * answer at 500 matches, so such a request keeps the list walk.
 */
const FULL_INDEX_MIN_RESULTS = 5001;

/**
 * Older backends do not know the action: "unsupported filesystem action"
 * (422) without a query, and a 400 "unknown field \"query\"" with one, since
 * they reject unknown request fields before reading the action.
 */
function isMentionListUnsupported(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (status === 422) return /unsupported filesystem action|unknown action/i.test(message);
  if (status === 400) return /unknown field/i.test(message);
  return false;
}

function isHiddenPath(path: string) {
  return path.split("/").some((segment) => segment.startsWith("."));
}

/**
 * The browser host's `fs_mention_list`: K-brain's mention_list when the backend
 * has it (`supported`), otherwise, or when the backend turns the action down,
 * the list walk above.
 */
export async function listFileMentions(
  fs: {
    supported: () => Promise<boolean>;
    mentionList: (request: KBrainFsMentionListRequest) => Promise<KBrainFsMentionListResponse>;
    list: (request: KBrainFsListRequest) => Promise<KBrainFsListResponse>;
  },
  args: Record<string, unknown> | undefined,
): Promise<FileMentionListResult> {
  const workdir = typeof args?.workdir === "string" ? args.workdir.trim() : "";
  const query = normalizeFileMentionQuery(args?.query);
  const requested =
    typeof args?.max_results === "number" && args.max_results > 0
      ? args.max_results
      : DEFAULT_MAX_RESULTS;
  const fullIndex = !query && requested >= FULL_INDEX_MIN_RESULTS;
  if (workdir && !fullIndex && (await fs.supported().catch(() => false))) {
    try {
      const response = await fs.mentionList({
        action: "mention_list",
        workdir,
        path: "",
        query,
        max_results: Math.min(requested, MENTION_LIST_MAX_RESULTS),
      });
      const showHidden = args?.show_hidden === true;
      const entries = (response.entries ?? [])
        .map((entry) => ({
          path: entry.path,
          kind: entry.kind === "dir" ? ("dir" as const) : ("file" as const),
          hidden: isHiddenPath(entry.path),
        }))
        .filter((entry) => entry.path && (showHidden || !entry.hidden));
      return { entries, truncated: response.truncated === true };
    } catch (error) {
      if (!isMentionListUnsupported(error)) throw error;
    }
  }
  return listFileMentionsViaFsList(fs.list, args);
}
