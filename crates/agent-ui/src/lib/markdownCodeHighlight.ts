// Bounded, stream-aware wrapper around @streamdown/code's shiki plugin.
//
// The upstream plugin has two costs this wrapper contains:
//   1. Unbounded memory: every unique (code, lang, themes) call stores its
//      token arrays in a module-level Map forever. A streaming code block
//      produces hundreds of intermediate states, each cached and never hit
//      again — a long session leaks steadily.
//   2. Per-delta re-tokenize: a growing block misses the exact cache on every
//      flush, so shiki re-tokenizes the whole block per delta on the main
//      thread (expanded/small blocks; huge ones are collapsed by policy).
//
// Strategy — the wrapper sits in front and only forwards "worth it" calls:
//   - exact-match LRU (bounded) answers repeats without touching upstream;
//   - a growing block is identified by (language + themes + head of code);
//     same identity re-highlights at most once per THROTTLE_MS. In between,
//     the previous tokens of that identity are returned (stale by a few
//     trailing lines — invisible during fast streaming) and a trailing timer
//     forwards the newest content, so the final state is always exact.
// Upstream's internal cache then only accumulates one entry per throttle
// step instead of one per delta (~20x fewer), and our own caches are bounded.
//
// Forwarded calls also go through a one-at-a-time queue. Upstream tokenizes
// inside the callback of a shared promise, so every block that asks in the
// same render (opening a conversation, rows scrolling into view) used to be
// tokenized back to back in one microtask checkpoint: a single long task that
// grows with the number of visible code blocks. The queue hands upstream one
// block per macrotask and starts the next only after the previous delivered,
// so frames and input run in between.
import {
  code as baseCodePlugin,
  type CodeHighlighterPlugin,
  type HighlightOptions,
  type HighlightResult,
} from "@streamdown/code";

const EXACT_CACHE_LIMIT = 256;
const IDENTITY_CACHE_LIMIT = 64;
const IDENTITY_HEAD_CHARS = 80;
const THROTTLE_MS = 300;
// Upstream drops the callback when highlighting fails (it only logs), so a
// queued job that never delivers must not stall the blocks behind it.
const QUEUE_JOB_TIMEOUT_MS = 2_000;

export type HighlightScheduler = (run: () => void) => void;

const scheduleMacrotask: HighlightScheduler = (run) => {
  setTimeout(run, 0);
};

type HighlightJob = (done: () => void) => void;

// Serial, macrotask-paced runner for upstream highlight calls.
function createHighlightQueue(schedule: HighlightScheduler, jobTimeoutMs: number) {
  const jobs: HighlightJob[] = [];
  let busy = false;
  const pump = () => {
    if (busy) return;
    const job = jobs.shift();
    if (!job) return;
    busy = true;
    schedule(() => {
      let finished = false;
      const timer = setTimeout(() => done(), jobTimeoutMs);
      const done = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        busy = false;
        pump();
      };
      try {
        job(done);
      } catch (error) {
        done();
        throw error;
      }
    });
  };
  return (job: HighlightJob) => {
    jobs.push(job);
    pump();
  };
}

type IdentityEntry = {
  lastForwardAt: number;
  // Code of the most recent forward. A request is only allowed to reuse
  // `lastResult` when it is a strict growth of this text: the identity key
  // (first line) is deliberately coarse, so unrelated blocks may share a
  // slot, and answering them with another block's tokens would stick — a
  // settled block never re-requests.
  lastCode: string;
  lastResult: HighlightResult | null;
  pending: { options: HighlightOptions; callback?: (result: HighlightResult) => void } | null;
  timer: ReturnType<typeof setTimeout> | null;
};

function themeName(theme: HighlightOptions["themes"][number]): string {
  return typeof theme === "string" ? theme : (theme.name ?? "custom");
}

function exactKey(options: HighlightOptions): string {
  const { code, language, themes } = options;
  const tail = code.length > 100 ? code.slice(-100) : "";
  return `${language}:${themeName(themes[0])}:${themeName(themes[1])}:${code.length}:${code.slice(0, 100)}:${tail}`;
}

// A growing block's identity: language + themes + its FIRST LINE. The first
// line settles within a frame or two of streaming (unlike a fixed-width head,
// which keeps changing until the block outgrows it), so the throttle window
// engages almost immediately. Single-line blocks shorter than the cap change
// identity while growing and thus skip throttling — exactly the blocks where
// tokenizing is cheap. Distinct blocks sharing language AND first line (`{`
// for JSON, a shebang, a common import) collide on the same slot; the
// `lastCode` prefix check in `highlight` keeps that collision from ever
// answering one block with another block's tokens.
function identityKey(options: HighlightOptions): string {
  const { code, language, themes } = options;
  const newline = code.indexOf("\n");
  const firstLine =
    newline === -1
      ? code.slice(0, IDENTITY_HEAD_CHARS)
      : code.slice(0, Math.min(newline, IDENTITY_HEAD_CHARS));
  return `${language}:${themeName(themes[0])}:${themeName(themes[1])}:${firstLine}`;
}

// Map preserves insertion order; delete+set on hit turns it into an LRU.
function lruGet<Value>(cache: Map<string, Value>, key: string): Value | undefined {
  const value = cache.get(key);
  if (value !== undefined) {
    cache.delete(key);
    cache.set(key, value);
  }
  return value;
}

function lruSet<Value>(cache: Map<string, Value>, key: string, value: Value, limit: number) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > limit) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function createThrottledCodePlugin(
  base: CodeHighlighterPlugin = baseCodePlugin,
  config: { schedule?: HighlightScheduler; jobTimeoutMs?: number } = {},
): CodeHighlighterPlugin {
  const exactCache = new Map<string, HighlightResult>();
  const identities = new Map<string, IdentityEntry>();
  const enqueue = createHighlightQueue(
    config.schedule ?? scheduleMacrotask,
    config.jobTimeoutMs ?? QUEUE_JOB_TIMEOUT_MS,
  );

  // Always answers through `callback`: the forward itself only queues.
  const forward = (
    entry: IdentityEntry,
    options: HighlightOptions,
    callback?: (result: HighlightResult) => void,
  ): null => {
    entry.lastForwardAt = Date.now();
    entry.lastCode = options.code;
    const key = exactKey(options);
    enqueue((done) => {
      const deliver = (result: HighlightResult) => {
        entry.lastResult = result;
        lruSet(exactCache, key, result, EXACT_CACHE_LIMIT);
        callback?.(result);
        done();
      };
      // Another view of the same code may have been tokenized while this one waited.
      const cached = lruGet(exactCache, key);
      if (cached) {
        deliver(cached);
        return;
      }
      const immediate = base.highlight(options, deliver);
      if (immediate) deliver(immediate);
    });
    return null;
  };

  return {
    name: base.name,
    type: base.type,
    supportsLanguage: (language) => base.supportsLanguage(language),
    getSupportedLanguages: () => base.getSupportedLanguages(),
    getThemes: () => base.getThemes(),
    highlight(options, callback) {
      const cached = lruGet(exactCache, exactKey(options));
      if (cached) return cached;

      const key = identityKey(options);
      let entry = lruGet(identities, key);
      if (!entry) {
        entry = { lastForwardAt: 0, lastCode: "", lastResult: null, pending: null, timer: null };
        lruSet(identities, key, entry, IDENTITY_CACHE_LIMIT);
      }

      // Only a strict growth of the last forwarded code is the same block
      // still streaming. Anything else (a sibling block that merely shares
      // the first line, or a rewritten block) must not borrow stale tokens
      // nor silently replace a pending trailing run that belongs to another
      // block: forward now and, if that other block's trailing run was still
      // queued, forward it too so its final callback always lands.
      const wait = THROTTLE_MS - (Date.now() - entry.lastForwardAt);
      const growsLastCode = entry.lastCode.length > 0 && options.code.startsWith(entry.lastCode);
      if (wait <= 0 || !growsLastCode) {
        const displaced = entry.pending;
        entry.pending = null;
        if (entry.timer !== null) {
          clearTimeout(entry.timer);
          entry.timer = null;
        }
        if (displaced && !options.code.startsWith(displaced.options.code)) {
          forward(entry, displaced.options, displaced.callback);
        }
        return forward(entry, options, callback);
      }

      // Same block still growing inside the throttle window: remember the
      // newest content for the trailing run and answer with the previous
      // tokens (or null → skeleton) meanwhile.
      entry.pending = { options, callback };
      if (entry.timer === null) {
        const scheduled = entry;
        scheduled.timer = setTimeout(() => {
          scheduled.timer = null;
          const pending = scheduled.pending;
          scheduled.pending = null;
          if (pending) forward(scheduled, pending.options, pending.callback);
        }, wait);
      }
      return entry.lastResult;
    },
  };
}

// 测试环境会把 @streamdown/code mock 成 { code: undefined }（禁用高亮）；
// 此时透传 undefined 给 Streamdown（= 无高亮），与 mock 意图一致。
export const throttledCodePlugin: CodeHighlighterPlugin | undefined = baseCodePlugin
  ? createThrottledCodePlugin(baseCodePlugin)
  : undefined;
