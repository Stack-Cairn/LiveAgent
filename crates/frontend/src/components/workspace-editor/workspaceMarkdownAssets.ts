// Classification and resolution of link/image targets found in a markdown
// file rendered by the workspace file preview. `markdownPath` is the
// workdir-relative logical path of the markdown file (forward slashes, no
// leading slash), as returned by the fs backend.

export type WorkspaceMarkdownTarget =
  | { kind: "external"; url: string }
  | { kind: "inline"; url: string }
  | { kind: "hash"; fragment: string }
  | { kind: "workspace"; path: string }
  | { kind: "unsupported" };

const URL_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

function decodePathSegment(segment: string) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// Resolves a relative (or workspace-root-absolute) markdown target against
// the markdown file's directory. Returns a workdir-relative path, or null
// when the target escapes the workspace root or resolves to nothing.
export function resolveWorkspaceMarkdownPath(markdownPath: string, target: string): string | null {
  const withoutFragment = target.split("#")[0] ?? "";
  const withoutQuery = withoutFragment.split("?")[0] ?? "";
  const normalized = withoutQuery.replace(/\\/g, "/");
  if (!normalized) return null;

  const segments = normalized.startsWith("/")
    ? []
    : markdownPath
        .replace(/\\/g, "/")
        .split("/")
        .slice(0, -1)
        .filter((segment) => segment && segment !== ".");

  for (const rawSegment of normalized.split("/")) {
    const segment = decodePathSegment(rawSegment);
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!segments.length) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  return segments.length ? segments.join("/") : null;
}

export function classifyWorkspaceMarkdownTarget(
  markdownPath: string,
  rawTarget: string | null | undefined,
): WorkspaceMarkdownTarget {
  const target = typeof rawTarget === "string" ? rawTarget.trim() : "";
  if (!target) return { kind: "unsupported" };

  if (target.startsWith("#")) {
    const fragment = decodePathSegment(target.slice(1));
    return fragment ? { kind: "hash", fragment } : { kind: "unsupported" };
  }

  if (target.startsWith("//")) {
    return { kind: "external", url: `https:${target}` };
  }

  const schemeMatch = URL_SCHEME_PATTERN.exec(target);
  if (schemeMatch) {
    const scheme = schemeMatch[0].slice(0, -1).toLowerCase();
    if (scheme === "http" || scheme === "https" || scheme === "mailto") {
      return { kind: "external", url: target };
    }
    if (scheme === "data" || scheme === "blob") {
      return { kind: "inline", url: target };
    }
    return { kind: "unsupported" };
  }

  const path = resolveWorkspaceMarkdownPath(markdownPath, target);
  return path ? { kind: "workspace", path } : { kind: "unsupported" };
}

// GitHub-style heading slug, close enough to match the anchors that markdown
// tables of contents link to (`#section-name`).
export function workspaceMarkdownHeadingSlug(text: string) {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}_-]/gu, "");
}
