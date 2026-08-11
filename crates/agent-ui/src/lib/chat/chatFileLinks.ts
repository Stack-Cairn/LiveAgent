export type ChatFileLink = {
  path: string;
  line?: number;
  endLine?: number;
  column?: number;
  source: "absolute" | "relative" | "file-url";
};

const WINDOWS_DRIVE_PATH_PATTERN = /^[a-zA-Z]:[\\/]/;
const WINDOWS_UNC_PATH_PATTERN = /^(?:\\\\|\/\/)/;
const FILE_URL_PATTERN = /^file:\/\//i;
const ABSOLUTE_POSIX_PATH_PATTERN = /^\//;
// Home-anchored paths ("~" or "~/...") resolve on the conversation's host
// device, so they classify as absolute; the host expands the tilde.
const HOME_ANCHORED_PATH_PATTERN = /^~(?:\/|$)/;
// URL-style Windows drive paths ("/D:/work/a.ts") keep a leading slash that
// no filesystem accepts; strip it exactly like the file-url branch does.
const URL_STYLE_DRIVE_PATH_PATTERN = /^\/([a-zA-Z]:\/)/;
const URI_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z\d+.-]*:/;
const LOCATION_FRAGMENT_PATTERN = /^#L([1-9]\d*)(?:-L?([1-9]\d*))?$/i;
const LOCATION_SUFFIX_PATTERN = /:([1-9]\d*)(?::([1-9]\d*))?$/;
const INTERNAL_PAYLOAD_VERSION = "1";
const MAX_LOCATION_VALUE = 0xffff_ffff;

function parseLocationNumber(value: string) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= MAX_LOCATION_VALUE ? parsed : null;
}

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizePath(path: string) {
  const decoded = safeDecode(path);
  const isUnc = /^(?:\\\\|\/\/[^/])/.test(decoded);
  const collapsed = decoded.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  return isUnc ? `//${collapsed.replace(/^\/+/, "")}` : collapsed;
}

function isAbsolutePath(path: string) {
  return (
    WINDOWS_DRIVE_PATH_PATTERN.test(path) ||
    WINDOWS_UNC_PATH_PATTERN.test(path) ||
    ABSOLUTE_POSIX_PATH_PATTERN.test(path) ||
    HOME_ANCHORED_PATH_PATTERN.test(path)
  );
}

function parseTrailingLocation(value: string) {
  let path = value.trim();
  let line: number | undefined;
  let endLine: number | undefined;
  let column: number | undefined;

  const hashIndex = path.lastIndexOf("#");
  const hashMatch = hashIndex >= 0 ? path.slice(hashIndex).match(LOCATION_FRAGMENT_PATTERN) : null;
  if (hashMatch) {
    line = parseLocationNumber(hashMatch[1]) ?? undefined;
    if (line === undefined) return { path: "", line, endLine, column };
    if (hashMatch[2]) {
      endLine = parseLocationNumber(hashMatch[2]) ?? undefined;
      if (endLine === undefined) return { path: "", line, endLine, column };
    }
    path = path.slice(0, hashIndex);
  }

  const lineMatch = line === undefined ? path.match(LOCATION_SUFFIX_PATTERN) : null;
  if (lineMatch?.index !== undefined) {
    line = parseLocationNumber(lineMatch[1]) ?? undefined;
    if (line === undefined) return { path: "", line, endLine, column };
    if (lineMatch[2]) {
      column = parseLocationNumber(lineMatch[2]) ?? undefined;
      if (column === undefined) return { path: "", line, endLine, column };
    }
    path = path.slice(0, lineMatch.index);
  }

  return { path, line, endLine, column };
}

function createChatFileLink(
  path: string,
  source: ChatFileLink["source"],
  location: Omit<ChatFileLink, "path" | "source">,
): ChatFileLink {
  return {
    path,
    ...(location.line === undefined ? {} : { line: location.line }),
    ...(location.endLine === undefined ? {} : { endLine: location.endLine }),
    ...(location.column === undefined ? {} : { column: location.column }),
    source,
  };
}

function isSafeRelativePath(path: string) {
  return (
    Boolean(path) &&
    path !== "." &&
    path !== ".." &&
    !path.startsWith("#") &&
    !path.includes("\0") &&
    !path.includes("\n") &&
    !path.includes("\r") &&
    !URI_SCHEME_PATTERN.test(path)
  );
}

export function parseChatFileLink(raw: string): ChatFileLink | null {
  const input = raw.trim();
  if (!input) return null;

  if (FILE_URL_PATTERN.test(input)) {
    try {
      const url = new URL(input);
      if (url.protocol !== "file:") return null;
      const hashLocation = url.hash.match(LOCATION_FRAGMENT_PATTERN);
      const hashLine = hashLocation ? parseLocationNumber(hashLocation[1]) : null;
      const hashEndLine = hashLocation?.[2] ? parseLocationNumber(hashLocation[2]) : null;
      if (hashLocation && (hashLine === null || (hashLocation[2] && hashEndLine === null))) {
        return null;
      }
      const locationFromHash = hashLocation
        ? {
            line: hashLine ?? undefined,
            ...(hashEndLine === null ? {} : { endLine: hashEndLine }),
          }
        : {};
      const pathWithHost = url.host ? `//${safeDecode(url.host)}${url.pathname}` : url.pathname;
      const trailing = parseTrailingLocation(pathWithHost);
      const normalized = normalizePath(trailing.path).replace(/^\/([a-zA-Z]:)/, "$1");
      if (!normalized || !isAbsolutePath(normalized)) return null;
      return createChatFileLink(normalized, "file-url", {
        ...trailing,
        ...locationFromHash,
      });
    } catch {
      return null;
    }
  }

  const { path, line, endLine, column } = parseTrailingLocation(input);
  const normalized = normalizePath(path).replace(URL_STYLE_DRIVE_PATH_PATTERN, "$1");

  if (isAbsolutePath(normalized)) {
    return createChatFileLink(normalized, "absolute", { line, endLine, column });
  }

  if (isSafeRelativePath(normalized)) {
    return createChatFileLink(normalized, "relative", { line, endLine, column });
  }

  return null;
}

export function isChatFileLinkTarget(raw: string) {
  return Boolean(parseChatFileLink(raw));
}

export function encodeChatFileLink(link: ChatFileLink) {
  const params = new URLSearchParams();
  params.set("v", INTERNAL_PAYLOAD_VERSION);
  params.set("path", link.path);
  if (link.line !== undefined) params.set("line", String(link.line));
  if (link.endLine !== undefined) params.set("endLine", String(link.endLine));
  if (link.column !== undefined) params.set("column", String(link.column));
  params.set("source", link.source);
  return `liveagent-file:${params.toString()}`;
}

export function decodeChatFileLinkPayload(payload: string): ChatFileLink | null {
  const params = new URLSearchParams(payload);
  const allowedKeys = new Set(["v", "path", "line", "endLine", "column", "source"]);
  for (const key of params.keys()) {
    if (!allowedKeys.has(key) || params.getAll(key).length !== 1) return null;
  }
  if (params.get("v") !== INTERNAL_PAYLOAD_VERSION) return null;
  const path = params.get("path") ?? "";
  const source = params.get("source");
  if (!path || (source !== "absolute" && source !== "relative" && source !== "file-url"))
    return null;

  const normalized = normalizePath(path).replace(URL_STYLE_DRIVE_PATH_PATTERN, "$1");
  const sourceMatches =
    source === "relative"
      ? isSafeRelativePath(normalized) && !isAbsolutePath(normalized)
      : isAbsolutePath(normalized);
  if (!sourceMatches) return null;

  const parseLocationValue = (key: "line" | "endLine" | "column") => {
    const value = params.get(key);
    if (value === null) return undefined;
    if (!/^[1-9]\d*$/.test(value)) return null;
    return parseLocationNumber(value);
  };
  const line = parseLocationValue("line");
  const endLine = parseLocationValue("endLine");
  const column = parseLocationValue("column");
  if (line === null || endLine === null || column === null) return null;
  if ((endLine !== undefined || column !== undefined) && line === undefined) return null;
  if (line !== undefined && endLine !== undefined && endLine < line) return null;

  return createChatFileLink(normalized, source, { line, endLine, column });
}
