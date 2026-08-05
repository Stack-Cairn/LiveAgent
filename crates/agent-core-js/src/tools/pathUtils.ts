import {
  assertSkillMutationAllowed,
  assertSkillPathAllowedByPolicy,
  buildSkillAccessDeniedMessage,
  isSkillAccessPolicyRestrictive,
  type SkillAccessPolicy,
} from "./skillAccessPolicy";

// Encoding contract: `file://` inputs are URLs and are always percent-decoded.
// `workspace:` / `skill:` / `skill://` references are literal tool-produced
// strings and are never encoded or decoded.

export type PathScope = "workspace" | "skill" | "external" | "uploads";

export type PathIntent = "read" | "write" | "edit" | "delete" | "list" | "search" | "cwd" | "image";

export type ResolvedPath = {
  scope: PathScope;
  input: string;
  // Backend base directory: workdir for workspace, skills root for skill,
  // the absolute path itself for external.
  root: string;
  absolutePath: string;
  relativePath?: string;
  displayPath: string;
  intent: PathIntent;
  skillBaseDir?: string;
};

type ResolveOptions = {
  label: string;
  intent: PathIntent;
  required?: boolean;
  allowExternal?: boolean;
  preferSkill?: boolean;
};

type ResolverOptions = {
  workdir: string;
  homeDir?: string;
  resolveHomeDir?: () => Promise<string>;
  skillsRootEnabled?: boolean;
  skillsRootDir?: string;
  skillAccessPolicy?: SkillAccessPolicy;
  resolveSkillsRootDir?: () => Promise<string>;
};

function normalizeUnicode(value: string) {
  return typeof value.normalize === "function" ? value.normalize("NFC") : value;
}

function normalizeWindowsExtendedPrefix(value: string) {
  if (/^\/\/[?.]\/UNC\//i.test(value)) {
    return `//${value.slice("//?/UNC/".length)}`;
  }
  if (/^\/\/[?.]\/[a-zA-Z]:\//.test(value)) {
    return value.slice("//?/".length);
  }
  return value;
}

function collapseDuplicateSeparators(value: string) {
  if (value.startsWith("//")) {
    return `//${value.slice(2).replace(/\/{2,}/g, "/")}`;
  }
  return value.replace(/\/{2,}/g, "/");
}

export function normalizeComparablePath(path: string) {
  const normalized = collapseDuplicateSeparators(
    normalizeWindowsExtendedPrefix(
      normalizeUnicode(String(path || ""))
        .trim()
        .replace(/\\/g, "/"),
    ),
  );
  if (/^[a-zA-Z]:\/?$/.test(normalized)) return normalized.replace(/\/?$/, "/");
  if (normalized === "/") return "/";
  return normalized.replace(/\/+$/g, "");
}

function isWindowsDrivePath(value: string) {
  return /^[a-zA-Z]:\//.test(value);
}

export function isAbsolutePath(value: string) {
  return value.startsWith("/") || isWindowsDrivePath(value);
}

function isUncPath(value: string) {
  return value.startsWith("//");
}

function normalizeRootPath(rootDir: string) {
  const normalized = normalizeComparablePath(rootDir);
  if (!normalized) throw new Error("Workspace root is not configured");
  if (isUncPath(normalized)) throw new Error(`Workspace root cannot be a UNC path: ${rootDir}`);
  return normalized;
}

export function relativePathFromAbsolute(rawPath: string, rootDir: string) {
  const path = normalizeComparablePath(rawPath);
  const root = normalizeComparablePath(rootDir);
  if (!path || !root) return null;

  const windowsCompare = isWindowsDrivePath(path) || isWindowsDrivePath(root);
  const comparablePath = windowsCompare ? path.toLowerCase() : path;
  const comparableRoot = windowsCompare ? root.toLowerCase() : root;

  if (comparablePath === comparableRoot) return "";
  return comparablePath.startsWith(`${comparableRoot}/`) ? path.slice(root.length + 1) : null;
}

function parseFileUrl(value: string) {
  if (!/^file:\/\//i.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "file:") return null;
    if (url.hostname && url.hostname.toLowerCase() !== "localhost") {
      throw new Error(`Invalid file URL: UNC paths are not supported: ${value}`);
    }
    let pathname = decodeURIComponent(url.pathname || "");
    if (pathname.startsWith("//")) {
      throw new Error(`Invalid file URL: UNC paths are not supported: ${value}`);
    }
    if (/^\/[a-zA-Z]:\//.test(pathname)) pathname = pathname.slice(1);
    return normalizeComparablePath(pathname);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Invalid file URL:")) {
      throw error;
    }
    throw new Error(`Invalid file URL: ${value}`);
  }
}

function normalizeRawPathInput(input: unknown, label: string) {
  if (typeof input !== "string") return "";
  const value = normalizeWindowsExtendedPrefix(normalizeUnicode(input.trim()).replace(/\\/g, "/"));
  if (value.includes("\0")) {
    throw new Error(`${label} contains a NUL byte and cannot be resolved`);
  }
  return value;
}

export function sanitizeRelativePath(input: string, label: string, required: boolean) {
  const normalized = normalizeUnicode(input.trim()).replace(/\\/g, "/");
  if (!normalized) {
    if (required) throw new Error(`${label} is required`);
    return undefined;
  }
  if (isUncPath(normalized)) throw new Error(`${label} cannot be a UNC path`);
  if (isAbsolutePath(normalized)) {
    throw new Error(`${label} cannot escape its resolved scope`);
  }

  const segments: string[] = [];
  for (const rawSegment of normalized.split("/")) {
    const segment = rawSegment.trim();
    if (!segment || segment === ".") continue;
    if (segment === "..") throw new Error(`${label} cannot contain .. segments`);
    if (segment.includes(":")) throw new Error(`${label} cannot contain ':' path segments`);
    if (segment.includes("\0")) throw new Error(`${label} contains a NUL byte`);
    segments.push(segment);
  }

  if (segments.length === 0) {
    if (required) throw new Error(`${label} must identify a file or directory`);
    return undefined;
  }
  return segments.join("/");
}

export function joinNormalizedPath(rootDir: string, relativePath?: string) {
  const root = normalizeRootPath(rootDir);
  if (!relativePath) return root;
  if (root === "/") return `/${relativePath}`;
  return `${root.replace(/\/+$/g, "")}/${relativePath}`;
}

function firstPathSegment(path: string | undefined) {
  return path?.split("/").find(Boolean) ?? "";
}

function displayPathFor(scope: PathScope, relativePath: string | undefined, absolutePath: string) {
  if (scope === "workspace") return relativePath || ".";
  if (scope === "skill") return `skill://${relativePath || ""}`;
  return absolutePath;
}

function parseScopedPathRef(value: string) {
  const match = value.match(/^(workspace|skill):(.*)$/i);
  if (!match) return null;
  return {
    scope: match[1].toLowerCase() as "workspace" | "skill",
    relativePath: match[2].replace(/^\/+/, ""),
  };
}

function parseSkillUrl(value: string) {
  if (!/^skill:\/\//i.test(value)) return null;
  return value.replace(/^skill:\/\//i, "").replace(/^\/+/, "");
}

function fixedSkillsRelativePathFromAbsolute(value: string) {
  const normalized = normalizeComparablePath(value);
  const marker = "/.liveagent/skills/";
  const index = normalized.indexOf(marker);
  if (index < 0) return null;
  return normalized.slice(index + marker.length);
}

// Uploaded attachments are staged under ~/.liveagent/uploads (outside the
// workspace). Tools may read them; every mutating intent is rejected.
//
// Staging paths are recognized by marker substring, mirroring the fixed
// skills-root matching above: attachment absolute paths persisted in old
// messages must keep resolving even when the current resolver's view of the
// home directory differs from the one that produced them (another OS user,
// Windows drive letters, symlinked homes). The deliberate looseness — any
// absolute path containing the marker is treated as staged — only ever grants
// read access; mutating intents are rejected for everything it matches.
const UPLOAD_STAGING_MARKER = "/.liveagent/uploads/";
const UPLOAD_STAGING_READ_INTENTS = new Set<PathIntent>(["read", "list", "search", "image"]);

function uploadStagingSplitFromAbsolute(value: string) {
  const normalized = normalizeComparablePath(value);
  const index = normalized.indexOf(UPLOAD_STAGING_MARKER);
  if (index >= 0) {
    return {
      root: normalized.slice(0, index + UPLOAD_STAGING_MARKER.length - 1),
      relativePath: normalized.slice(index + UPLOAD_STAGING_MARKER.length),
    };
  }
  // The bare staging root (no trailing separator) must resolve too, so List
  // on ~/.liveagent/uploads can enumerate batch directories.
  if (normalized.endsWith(UPLOAD_STAGING_MARKER.slice(0, -1))) {
    return { root: normalized, relativePath: "" };
  }
  return null;
}

function operationForIntent(intent: PathIntent, label: string) {
  switch (intent) {
    case "write":
      return `Write(${label})`;
    case "edit":
      return `Edit(${label})`;
    case "delete":
      return `Delete(${label})`;
    case "list":
      return `List(${label})`;
    case "search":
      return `Search(${label})`;
    case "cwd":
      return `Bash(${label})`;
    case "image":
      return `Image(${label})`;
    default:
      return `Read(${label})`;
  }
}

export function formatResolvedTarget(path: Pick<ResolvedPath, "displayPath"> | undefined) {
  return path?.displayPath || ".";
}

export class ToolPathResolver {
  private readonly workdir: string;
  private readonly resolveHomeDirFn?: () => Promise<string>;
  private readonly skillsRootEnabled: boolean;
  private readonly skillAccessPolicy?: SkillAccessPolicy;
  private readonly resolveSkillsRootDir?: () => Promise<string>;
  private homeDir: string;
  private homeDirResolved: boolean;
  private skillsRootDir: string;

  constructor(options: ResolverOptions) {
    this.workdir = normalizeRootPath(options.workdir);
    this.homeDir =
      typeof options.homeDir === "string" ? normalizeComparablePath(options.homeDir) : "";
    this.homeDirResolved = this.homeDir.length > 0;
    this.resolveHomeDirFn = options.resolveHomeDir;
    this.skillsRootEnabled = options.skillsRootEnabled === true;
    this.skillsRootDir =
      typeof options.skillsRootDir === "string"
        ? normalizeComparablePath(options.skillsRootDir)
        : "";
    this.skillAccessPolicy = options.skillAccessPolicy;
    this.resolveSkillsRootDir = options.resolveSkillsRootDir;
  }

  setSkillsRootDir(rootDir: string | undefined) {
    this.skillsRootDir = typeof rootDir === "string" ? normalizeComparablePath(rootDir) : "";
  }

  private async getSkillsRootDir() {
    if (!this.skillsRootEnabled) return "";
    if (this.skillsRootDir) return this.skillsRootDir;
    const resolved = await this.resolveSkillsRootDir?.();
    this.skillsRootDir = typeof resolved === "string" ? normalizeComparablePath(resolved) : "";
    return this.skillsRootDir;
  }

  private async getHomeDir() {
    if (this.homeDirResolved) return this.homeDir;
    this.homeDirResolved = true;
    try {
      const resolved = await this.resolveHomeDirFn?.();
      this.homeDir = typeof resolved === "string" ? normalizeComparablePath(resolved) : "";
    } catch {
      this.homeDir = "";
    }
    return this.homeDir;
  }

  private async expandTilde(value: string) {
    if (value !== "~" && !value.startsWith("~/")) return value;
    const homeDir = await this.getHomeDir();
    if (!homeDir) {
      throw new Error(
        "Cannot resolve ~/ paths in this session; use a workspace-relative or absolute path instead",
      );
    }
    return normalizeComparablePath(`${homeDir}${value === "~" ? "" : value.slice(1)}`);
  }

  private async resolveSkillRelativePath(
    relativePath: string | undefined,
    options: ResolveOptions,
  ): Promise<ResolvedPath> {
    const skillsRootDir = await this.getSkillsRootDir();
    if (!skillsRootDir) {
      throw new Error(`${options.label} points to a Skill path, but Skills are not enabled`);
    }
    const sanitized = sanitizeRelativePath(relativePath ?? "", options.label, false);
    if (!sanitized && isSkillAccessPolicyRestrictive(this.skillAccessPolicy)) {
      throw new Error(
        buildSkillAccessDeniedMessage({
          operation: operationForIntent(options.intent, options.label),
          allowedSkillNames: this.skillAccessPolicy?.allowedSkillNames,
        }),
      );
    }
    if (!sanitized && options.required === true) {
      throw new Error(
        `${options.label} must include the skill name and a file path after skill://, for example "skill://<skill-name>/SKILL.md". "skill://" alone does not identify a file.`,
      );
    }
    const operation = operationForIntent(options.intent, options.label);
    if (sanitized) {
      assertSkillPathAllowedByPolicy(this.skillAccessPolicy, sanitized, operation);
      if (options.intent === "write" || options.intent === "edit" || options.intent === "delete") {
        assertSkillMutationAllowed(this.skillAccessPolicy, operation, sanitized);
      }
    }
    const absolutePath = joinNormalizedPath(skillsRootDir, sanitized);
    return {
      scope: "skill",
      input: relativePath ?? "",
      root: skillsRootDir,
      absolutePath,
      relativePath: sanitized,
      displayPath: displayPathFor("skill", sanitized, absolutePath),
      intent: options.intent,
      skillBaseDir: firstPathSegment(sanitized),
    };
  }

  private resolveWorkspaceRelativePath(
    relativePath: string | undefined,
    options: ResolveOptions,
  ): ResolvedPath {
    const sanitized = sanitizeRelativePath(
      relativePath ?? "",
      options.label,
      options.required === true,
    );
    const absolutePath = joinNormalizedPath(this.workdir, sanitized);
    return {
      scope: "workspace",
      input: relativePath ?? "",
      root: this.workdir,
      absolutePath,
      relativePath: sanitized,
      displayPath: displayPathFor("workspace", sanitized, absolutePath),
      intent: options.intent,
    };
  }

  private resolveUploadStagingPath(
    split: { root: string; relativePath: string },
    options: ResolveOptions,
  ): ResolvedPath {
    const rawDisplay = split.relativePath ? `uploads/${split.relativePath}` : "uploads";
    if (!UPLOAD_STAGING_READ_INTENTS.has(options.intent)) {
      throw new Error(
        `${options.label} targets the upload staging area, which only supports read access (Read/List/Grep/Image): ${rawDisplay}. Copy the file into the workspace first if it needs changes.`,
      );
    }
    const sanitized = split.relativePath
      ? sanitizeRelativePath(split.relativePath, options.label, true)
      : undefined;
    const absolutePath = sanitized ? joinNormalizedPath(split.root, sanitized) : split.root;
    return {
      scope: "uploads",
      input: absolutePath,
      root: split.root,
      absolutePath,
      relativePath: sanitized,
      displayPath: sanitized ? `uploads/${sanitized}` : "uploads",
      intent: options.intent,
    };
  }

  private resolveExternalAbsolutePath(value: string, options: ResolveOptions): ResolvedPath {
    const absolutePath = normalizeComparablePath(value);
    if (!options.allowExternal) {
      throw new Error(
        `${options.label} resolves outside the workspace and enabled Skills: ${absolutePath}. Pass a workspace-relative path instead — for example path="notes.md" targets <workspace root>/notes.md — or an enabled skill:// path, exactly as returned by List/Glob/Grep/Read.`,
      );
    }
    return {
      scope: "external",
      input: value,
      root: absolutePath,
      absolutePath,
      displayPath: displayPathFor("external", undefined, absolutePath),
      intent: options.intent,
    };
  }

  private async resolveAbsolutePath(value: string, options: ResolveOptions): Promise<ResolvedPath> {
    const absolutePath = normalizeComparablePath(value);
    const workspaceRel = relativePathFromAbsolute(absolutePath, this.workdir);
    const skillsRootDir = await this.getSkillsRootDir();
    const skillRel = skillsRootDir ? relativePathFromAbsolute(absolutePath, skillsRootDir) : null;

    // When both roots contain the path (nested roots), the longer root is the
    // more specific owner and its scope policy must win.
    if (workspaceRel !== null && skillRel !== null) {
      return skillsRootDir.length >= this.workdir.length
        ? this.resolveSkillRelativePath(skillRel, options)
        : this.resolveWorkspaceRelativePath(workspaceRel, options);
    }
    if (skillRel !== null) {
      return this.resolveSkillRelativePath(skillRel, options);
    }
    if (workspaceRel !== null) {
      return this.resolveWorkspaceRelativePath(workspaceRel, options);
    }

    const fixedSkillRel = fixedSkillsRelativePathFromAbsolute(absolutePath);
    if (fixedSkillRel !== null) {
      if (!this.skillsRootEnabled) {
        throw new Error(
          `${options.label} points to installed Skill files, but Skills are not enabled for this conversation. Enable the Skill, then retry with skill://${fixedSkillRel}`,
        );
      }
      return this.resolveSkillRelativePath(fixedSkillRel, options);
    }

    const uploadSplit = uploadStagingSplitFromAbsolute(absolutePath);
    if (uploadSplit !== null) {
      return this.resolveUploadStagingPath(uploadSplit, options);
    }

    return this.resolveExternalAbsolutePath(absolutePath, options);
  }

  async resolvePath(input: unknown, options: ResolveOptions): Promise<ResolvedPath> {
    const raw = normalizeRawPathInput(input, options.label);
    if (!raw) {
      if (options.required) throw new Error(`${options.label} is required`);
      return this.resolveWorkspaceRelativePath(undefined, options);
    }

    if (isUncPath(raw)) throw new Error(`${options.label} cannot be a UNC path`);

    const scopedRef = parseScopedPathRef(raw);
    if (scopedRef?.scope === "workspace") {
      return this.resolveWorkspaceRelativePath(scopedRef.relativePath, options);
    }
    if (scopedRef?.scope === "skill") {
      return this.resolveSkillRelativePath(scopedRef.relativePath, options);
    }

    const skillUrlPath = parseSkillUrl(raw);
    if (skillUrlPath !== null) {
      return this.resolveSkillRelativePath(skillUrlPath, options);
    }

    const fileUrlPath = parseFileUrl(raw);
    if (fileUrlPath !== null) {
      return this.resolveAbsolutePath(fileUrlPath, options);
    }

    if (raw.startsWith("~")) {
      // "~/.liveagent/skills/..." is recognizable without knowing the home
      // directory; resolve it as a Skill path before attempting ~ expansion.
      const fixedSkillRel = fixedSkillsRelativePathFromAbsolute(raw);
      if (fixedSkillRel !== null) {
        if (!this.skillsRootEnabled) {
          throw new Error(
            `${options.label} points to installed Skill files, but Skills are not enabled for this conversation. Enable the Skill, then retry with skill://${fixedSkillRel}`,
          );
        }
        return this.resolveSkillRelativePath(fixedSkillRel, options);
      }
    }

    const expanded = raw.startsWith("~") ? await this.expandTilde(raw) : raw;
    if (isUncPath(expanded)) throw new Error(`${options.label} cannot be a UNC path`);
    if (isAbsolutePath(expanded)) {
      return this.resolveAbsolutePath(expanded, options);
    }

    if (options.preferSkill) {
      return this.resolveSkillRelativePath(expanded, options);
    }
    return this.resolveWorkspaceRelativePath(expanded, options);
  }
}
