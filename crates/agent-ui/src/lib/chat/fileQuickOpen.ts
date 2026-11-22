/**
 * Fuzzy matching for the palette's `@` file scope. Pure functions only: the
 * same code runs inside the quick-open Web Worker and in the synchronous
 * fallback used by tests and hosts without Worker support.
 *
 * A query matches a path when its characters appear in order (whitespace in
 * the query is ignored). Matches are scored so that the file name beats the
 * directory part, runs of consecutive characters beat scattered ones, and
 * characters at word starts (after `/`, `_`, `-`, `.`, or a camelCase hump)
 * beat characters in the middle of a word.
 */

export type QuickOpenMatch = {
  path: string;
  score: number;
  /** Indices into `path` of the matched characters, ascending. */
  positions: number[];
};

export const QUICK_OPEN_DEFAULT_LIMIT = 50;

const SEPARATORS = new Set(["/", "\\", "_", "-", ".", " "]);

const SCORE_MATCH = 1;
const SCORE_CONSECUTIVE = 6;
const SCORE_WORD_START = 8;
const SCORE_IN_BASENAME = 2;
const PENALTY_GAP = 0.15;
const PENALTY_GAP_MAX = 3;
const BONUS_BASENAME_EXACT = 120;
const BONUS_BASENAME_STEM_EXACT = 90;
const BONUS_BASENAME_PREFIX = 40;
const BONUS_BASENAME_SUBSTRING = 20;
const BONUS_PATH_SUBSTRING = 10;
const PENALTY_PATH_LENGTH = 0.02;

export function normalizeQuickOpenQuery(query: string): string {
  return query.replace(/\s+/g, "").toLocaleLowerCase();
}

function basenameStart(path: string): number {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return slash + 1;
}

function isWordStart(path: string, index: number): boolean {
  if (index === 0) return true;
  const previous = path[index - 1] ?? "";
  if (SEPARATORS.has(previous)) return true;
  const current = path[index] ?? "";
  // camelCase hump: a lower-case letter followed by an upper-case one.
  return (
    previous !== previous.toUpperCase() &&
    current === current.toUpperCase() &&
    current !== current.toLowerCase()
  );
}

/**
 * Greedy in-order match starting at `from`, preferring word starts: for each
 * query character it takes the next word-start occurrence when one exists
 * before the next plain occurrence would force a longer gap. Returns null when
 * the query cannot be matched.
 */
function matchFrom(lowerPath: string, path: string, query: string, from: number): number[] | null {
  const positions: number[] = [];
  let cursor = from;
  for (let q = 0; q < query.length; q += 1) {
    const char = query[q];
    const next = lowerPath.indexOf(char, cursor);
    if (next < 0) return null;
    // Continue a run when possible; otherwise jump to a word start of the
    // same character if one exists before the end of the path.
    let chosen = next;
    const previous = positions.at(-1);
    if (previous === undefined || next !== previous + 1) {
      let probe = next;
      while (probe >= 0) {
        if (isWordStart(path, probe)) {
          chosen = probe;
          break;
        }
        probe = lowerPath.indexOf(char, probe + 1);
      }
      // Only take the word start when the rest of the query still fits after it.
      if (chosen !== next && !fitsAfter(lowerPath, query, q + 1, chosen + 1)) chosen = next;
    }
    positions.push(chosen);
    cursor = chosen + 1;
  }
  return positions;
}

function fitsAfter(lowerPath: string, query: string, queryIndex: number, from: number): boolean {
  let cursor = from;
  for (let q = queryIndex; q < query.length; q += 1) {
    const next = lowerPath.indexOf(query[q], cursor);
    if (next < 0) return false;
    cursor = next + 1;
  }
  return true;
}

function scorePositions(path: string, positions: readonly number[], nameStart: number): number {
  let score = 0;
  let previous = -1;
  for (const position of positions) {
    score += SCORE_MATCH;
    if (previous >= 0 && position === previous + 1) score += SCORE_CONSECUTIVE;
    else if (previous >= 0) {
      score -= Math.min(PENALTY_GAP_MAX, (position - previous - 1) * PENALTY_GAP);
    }
    if (isWordStart(path, position)) score += SCORE_WORD_START;
    if (position >= nameStart) score += SCORE_IN_BASENAME;
    previous = position;
  }
  return score;
}

/** Scores one path against a normalized query (see normalizeQuickOpenQuery). */
export function scoreQuickOpenPath(path: string, normalizedQuery: string): QuickOpenMatch | null {
  if (!normalizedQuery) return { path, score: 0, positions: [] };
  const lowerPath = path.toLocaleLowerCase();
  const nameStart = basenameStart(path);

  // Two candidates: the whole query inside the file name, or anywhere in the path.
  const candidates: number[][] = [];
  const inName = matchFrom(lowerPath, path, normalizedQuery, nameStart);
  if (inName) candidates.push(inName);
  const anywhere = matchFrom(lowerPath, path, normalizedQuery, 0);
  if (!anywhere) return inName ? finish(path, lowerPath, nameStart, normalizedQuery, inName) : null;
  candidates.push(anywhere);

  let best: QuickOpenMatch | null = null;
  for (const positions of candidates) {
    const match = finish(path, lowerPath, nameStart, normalizedQuery, positions);
    if (!best || match.score > best.score) best = match;
  }
  return best;
}

function finish(
  path: string,
  lowerPath: string,
  nameStart: number,
  query: string,
  positions: number[],
): QuickOpenMatch {
  let score = scorePositions(path, positions, nameStart);
  const name = lowerPath.slice(nameStart);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  if (name === query) score += BONUS_BASENAME_EXACT;
  else if (stem === query) score += BONUS_BASENAME_STEM_EXACT;
  else if (name.startsWith(query)) score += BONUS_BASENAME_PREFIX;
  else if (name.includes(query)) score += BONUS_BASENAME_SUBSTRING;
  else if (lowerPath.includes(query)) score += BONUS_PATH_SUBSTRING;
  score -= path.length * PENALTY_PATH_LENGTH;
  return { path, score, positions };
}

function compareMatches(a: QuickOpenMatch, b: QuickOpenMatch): number {
  return b.score - a.score || a.path.length - b.path.length || (a.path < b.path ? -1 : 1);
}

/**
 * Best `limit` matches for `query`, highest score first. An empty query keeps
 * the index order (the backend lists shallow paths first).
 */
export function searchQuickOpenPaths(
  paths: readonly string[],
  query: string,
  limit: number = QUICK_OPEN_DEFAULT_LIMIT,
): QuickOpenMatch[] {
  const normalized = normalizeQuickOpenQuery(query);
  if (!normalized) {
    return paths.slice(0, limit).map((path) => ({ path, score: 0, positions: [] }));
  }
  const matches: QuickOpenMatch[] = [];
  for (const path of paths) {
    const match = scoreQuickOpenPath(path, normalized);
    if (match) matches.push(match);
  }
  matches.sort(compareMatches);
  return matches.length > limit ? matches.slice(0, limit) : matches;
}

/** Splits a path into highlighted / plain runs for rendering. */
export function splitQuickOpenHighlights(
  text: string,
  positions: readonly number[],
  offset = 0,
): Array<{ text: string; highlighted: boolean }> {
  const marked = new Set(positions.map((position) => position - offset));
  const runs: Array<{ text: string; highlighted: boolean }> = [];
  for (let index = 0; index < text.length; index += 1) {
    const highlighted = marked.has(index);
    const last = runs.at(-1);
    if (last && last.highlighted === highlighted) last.text += text[index];
    else runs.push({ text: text[index] ?? "", highlighted });
  }
  return runs;
}
