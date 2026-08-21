import type { Tool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { isAlwaysEnabledSkillName } from "@liveagent/ui/lib/skills/builtin";

import { manageSkill, notifySkillsDiscoveryUpdated } from "@liveagent/ui/lib/skills/index";
import { Type } from "typebox";
import {
  type BuiltinToolBundle,
  createBuiltinMetadataMap,
  type SkillsManagerActionResultDetails,
  type SkillsManagerResultDetails,
} from "./builtinTypes";
import {
  isAbsolutePath,
  joinNormalizedPath,
  normalizeComparablePath,
  relativePathFromAbsolute,
} from "./pathUtils";
import {
  assertSkillInventoryAllowed,
  assertSkillManagementAllowed,
  assertSkillNameAllowedByPolicy,
  assertSkillPathAllowedByPolicy,
  filterSkillsByAccessPolicy,
  grantSkillsToAccessPolicy,
  isSkillAccessPolicyRestrictive,
  isSkillNameProtectedByPolicy,
  normalizeSkillBaseDir,
  type SkillAccessPolicy,
} from "./skillAccessPolicy";

function asErrorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

function normalizeSkillPath(input: unknown) {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw) return "";
  if (/^skill:\/\//i.test(raw)) {
    return raw
      .replace(/^skill:\/\//i, "")
      .replace(/^\/+/, "")
      .replace(/\\/g, "/");
  }
  if (/^skill:/i.test(raw)) {
    return raw
      .replace(/^skill:/i, "")
      .replace(/^\/+/, "")
      .replace(/\\/g, "/");
  }
  if (/^[a-zA-Z]:[\\/]/.test(raw)) return "";
  if (raw.startsWith("/") || raw.startsWith("\\\\")) return "";
  return raw.replace(/^[.][\\/]/, "");
}

function splitTextLinesWithEndings(text: string) {
  return text.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

function countSkillTextLines(text: string) {
  return splitTextLinesWithEndings(text).length;
}

function formatSkillLineWindow(startLine: number, numLines: number) {
  if (numLines === 0) return `empty @ ${startLine}`;
  return `${startLine}-${startLine + numLines - 1}`;
}

const SKILL_MANAGER_PARAMETERS = Type.Object({
  action: Type.Union(
    [
      Type.Literal("read"),
      Type.Literal("list"),
      Type.Literal("install"),
      Type.Literal("create"),
      Type.Literal("validate"),
      Type.Literal("package"),
      Type.Literal("delete"),
      Type.Literal("clawhub_search"),
      Type.Literal("clawhub_install"),
    ],
    {
      description: "Skill management action.",
    },
  ),
  path: Type.Optional(
    Type.String({
      description:
        "Skill entry file path for action=read. Accepts skill://<baseDir>/SKILL.md, skill:<baseDir>/SKILL.md, or <baseDir>/SKILL.md.",
    }),
  ),
  offset: Type.Optional(
    Type.Number({ minimum: 0, description: "Starting line for read (0-based)." }),
  ),
  length: Type.Optional(
    Type.Number({ minimum: 0, description: "Number of lines to read (default: 200)." }),
  ),
  source: Type.Optional(
    Type.String({
      description:
        "Source for action=install: local directory, .zip/.skill archive, HTTP(S) archive/file URL, or GitHub repo/tree/blob URL.",
    }),
  ),
  query: Type.Optional(
    Type.String({
      description: "Search text for action=clawhub_search. Omit to browse ClawHub by sort.",
    }),
  ),
  sort: Type.Optional(
    Type.Union(
      [
        Type.Literal("downloads"),
        Type.Literal("stars"),
        Type.Literal("installs"),
        Type.Literal("updated"),
        Type.Literal("newest"),
      ],
      {
        description:
          "Browse sort for action=clawhub_search when query is omitted. Defaults to downloads.",
      },
    ),
  ),
  limit: Type.Optional(
    Type.Number({
      minimum: 1,
      maximum: 20,
      description: "Maximum ClawHub results for action=clawhub_search. Defaults to 10, max 20.",
    }),
  ),
  cursor: Type.Optional(
    Type.String({
      description: "Optional ClawHub pagination cursor for action=clawhub_search without query.",
    }),
  ),
  slug: Type.Optional(
    Type.String({
      description:
        "ClawHub skill slug for action=clawhub_install, as returned by action=clawhub_search.",
    }),
  ),
  owner: Type.Optional(
    Type.String({
      description:
        "ClawHub owner handle for action=clawhub_install, as returned by action=clawhub_search. Required to disambiguate when multiple publishers share the same slug (ClawHub rejects ambiguous downloads with HTTP 409).",
    }),
  ),
  version: Type.Optional(
    Type.String({
      description: "Optional ClawHub version/tag for action=clawhub_install. Defaults to latest.",
    }),
  ),
  name: Type.Optional(
    Type.String({
      description:
        "Skill name for create, validate, package, delete, or single-skill install rename. Use lowercase letters, digits, and hyphens.",
    }),
  ),
  description: Type.Optional(
    Type.String({
      description: "Skill description for action=create.",
    }),
  ),
  body: Type.Optional(
    Type.String({
      description:
        "Markdown body for action=create. Frontmatter is generated from name and description.",
    }),
  ),
  files: Type.Optional(
    Type.Array(
      Type.Object({
        path: Type.String({
          description: "Relative file path inside the created Skill directory.",
        }),
        content: Type.String({ description: "File content." }),
      }),
      {
        description:
          "Optional extra files for action=create, such as references/guide.md. Do not include SKILL.md.",
      },
    ),
  ),
  conflict: Type.Optional(
    Type.Union([Type.Literal("backup"), Type.Literal("fail"), Type.Literal("overwrite")], {
      description:
        "Conflict mode for install/create. install defaults to backup; create defaults to fail.",
    }),
  ),
  method: Type.Optional(
    Type.Union([Type.Literal("auto"), Type.Literal("download"), Type.Literal("git")], {
      description: "GitHub fetch method for action=install. Defaults to auto.",
    }),
  ),
  ref: Type.Optional(Type.String({ description: "Git ref for GitHub sources. Defaults to main." })),
});

function normalizeAction(args: Record<string, unknown>) {
  const action = typeof args.action === "string" ? args.action.trim() : "";
  if (action) return action;
  throw new Error("SkillsManager.action is required");
}

function optionalString(args: Record<string, unknown>, key: string) {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalNumber(args: Record<string, unknown>, key: string) {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalBoundedInteger(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
) {
  const value = optionalNumber(args, key);
  if (typeof value !== "number") return undefined;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function isUrlLike(value: string) {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value);
}

function resolveInstallSourceForWorkspace(source: string, workdir?: string) {
  const normalizedSource = source.trim();
  const normalizedWorkdir = typeof workdir === "string" ? workdir.trim() : "";
  if (
    !normalizedSource ||
    !normalizedWorkdir ||
    normalizedSource.startsWith("~") ||
    isUrlLike(normalizedSource) ||
    isAbsolutePath(normalizedSource.replace(/\\/g, "/"))
  ) {
    return normalizedSource;
  }
  const relative = normalizedSource
    .replace(/^[.][\\/]/, "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  return joinNormalizedPath(normalizedWorkdir, relative);
}

function displaySkillRootPath(rootDir: string, path: string | null | undefined) {
  const value = typeof path === "string" ? normalizeComparablePath(path) : "";
  if (!value) return "";
  const relative = relativePathFromAbsolute(value, rootDir);
  if (relative === "") return "skill://<root>";
  if (relative) return `skill://${relative}`;
  return value;
}

function appendUnique(out: string[], value: string) {
  const normalized = value.trim();
  if (!normalized || out.includes(normalized)) return;
  out.push(normalized);
}

function collectManagedSkillAccess(result: Awaited<ReturnType<typeof manageSkill>>) {
  const names: string[] = [];
  const baseDirs: string[] = [];
  const collect = (
    item: { name?: string | null; skillFile?: string | null } | null | undefined,
  ) => {
    if (!item) return;
    if (typeof item.name === "string") {
      appendUnique(names, item.name);
    }
    if (typeof item.skillFile === "string") {
      appendUnique(baseDirs, normalizeSkillBaseDir(item.skillFile));
    }
  };

  if (result.action === "install" || result.action === "clawhub_install") {
    for (const item of result.installed ?? []) collect(item);
  } else if (result.action === "create") {
    collect(result.created);
  }

  return { names, baseDirs };
}

function skillBaseDirFromPath(path: string) {
  const normalized = normalizeComparablePath(path);
  return normalized.split("/").find(Boolean) ?? "<baseDir>";
}

function buildSkillReadPathRules(path: string) {
  const baseDir = skillBaseDirFromPath(path);
  return [
    "",
    "<LiveAgentSkillFileRules>",
    `- This Skill file was read from skill://${baseDir}/... . For sibling files, use file tools with paths that start with skill://${baseDir}/.`,
    "- If the Skill text includes shell snippets that read Skill files with cat/ls/find/grep, use the dedicated file tools for those reads.",
    `- Use Read/List/Glob/Grep with path="skill://${baseDir}/..." to read or locate Skill files. Do not use Bash for those file operations.`,
    "</LiveAgentSkillFileRules>",
  ].join("\n");
}

function isSkillEntryPath(path: string) {
  const normalized = normalizeComparablePath(path).toLowerCase();
  return /(^|\/)(skill\.md|skill\.json|readme\.md)$/.test(normalized);
}

function buildSkillManagerErrorText(args: Record<string, unknown>, error: unknown) {
  const action = normalizeAction(args);
  const path = normalizeSkillPath(args.path);
  const message = asErrorMessage(error);
  if (action !== "read") return message;

  const baseDir = skillBaseDirFromPath(path);
  const lines = [
    message,
    'SkillsManager(action="read") is for Skill entry files such as <skill>/SKILL.md, <skill>/skill.json, or <skill>/README.md.',
  ];

  if (path && !isSkillEntryPath(path)) {
    lines.push(
      `The requested path "${path}" looks like a sibling file inside a Skill, not a Skill entry file.`,
    );
  }

  lines.push(
    `To read or locate files inside this Skill, retry with Read/List/Glob/Grep using path="skill://${baseDir}/...".`,
    "Do not use Bash cat/ls/find/grep or absolute ~/.liveagent/skills paths for Skill file access.",
  );

  return lines.join(" ");
}

function normalizeSkillManagerPayload(
  args: Record<string, unknown>,
  options: {
    workdir?: string;
  } = {},
) {
  const action = normalizeAction(args);
  const payload: Record<string, unknown> = { action };

  if (action === "read") {
    const path = normalizeSkillPath(args.path);
    if (!path) throw new Error("SkillsManager.path must be a Skill entry path for action=read");
    payload.path = path;
    const offset = optionalNumber(args, "offset");
    const length = optionalNumber(args, "length");
    if (typeof offset === "number") payload.offset = offset;
    if (typeof length === "number") payload.length = length;
    return payload;
  }

  if (action === "install") {
    const source = optionalString(args, "source");
    if (!source) throw new Error("SkillsManager.source is required for action=install");
    payload.source = resolveInstallSourceForWorkspace(source, options.workdir);
    for (const key of ["name", "conflict", "method", "ref", "slug", "version"]) {
      const value = optionalString(args, key);
      if (value) payload[key] = value;
    }
    return payload;
  }

  if (action === "clawhub_search") {
    for (const key of ["query", "sort", "cursor"]) {
      const value = optionalString(args, key);
      if (value) payload[key] = value;
    }
    const limit = optionalBoundedInteger(args, "limit", 1, 20);
    if (typeof limit === "number") payload.limit = limit;
    return payload;
  }

  if (action === "clawhub_install") {
    const slug = optionalString(args, "slug");
    if (!slug) throw new Error("SkillsManager.slug is required for action=clawhub_install");
    payload.slug = slug;
    for (const key of ["name", "conflict", "version", "owner"]) {
      const value = optionalString(args, key);
      if (value) payload[key] = value;
    }
    return payload;
  }

  if (action === "create") {
    for (const key of ["name", "description", "body", "conflict"]) {
      const value = optionalString(args, key);
      if (value) payload[key] = value;
    }
    if (!payload.name) throw new Error("SkillsManager.name is required for action=create");
    if (!payload.description)
      throw new Error("SkillsManager.description is required for action=create");
    if (Array.isArray(args.files)) payload.files = args.files;
    return payload;
  }

  if (action === "validate" || action === "package" || action === "delete") {
    const name = optionalString(args, "name");
    if (!name) throw new Error(`SkillsManager.name is required for action=${action}`);
    payload.name = name;
    return payload;
  }

  if (action === "list") return payload;

  throw new Error(
    `SkillsManager.action must be one of: read, list, install, create, validate, package, delete, clawhub_search, clawhub_install. Received: ${JSON.stringify(action)}`,
  );
}

function filterManageSkillResult(
  result: Awaited<ReturnType<typeof manageSkill>>,
  policy?: SkillAccessPolicy,
) {
  if (result.action !== "list") return result;
  return {
    ...result,
    skills: filterSkillsByAccessPolicy(policy, result.skills ?? []),
    invalid: filterSkillsByAccessPolicy(policy, result.invalid ?? []),
  };
}

function enforceSkillManagerAccessPolicy(
  payload: Record<string, unknown>,
  policy?: SkillAccessPolicy,
) {
  const action = typeof payload.action === "string" ? payload.action : "";
  if (action === "read") {
    assertSkillPathAllowedByPolicy(
      policy,
      String(payload.path ?? ""),
      'SkillsManager(action="read")',
    );
    return;
  }
  if (action === "list") {
    assertSkillInventoryAllowed(policy);
    return;
  }
  if (action === "clawhub_search") {
    assertSkillInventoryAllowed(policy);
    return;
  }
  if (action === "validate" || action === "package" || action === "delete") {
    assertSkillManagementAllowed(policy, action);
    const name = String(payload.name ?? "");
    assertSkillNameAllowedByPolicy(policy, name, `SkillsManager(action=${JSON.stringify(action)})`);
    if (isAlwaysEnabledSkillName(name) || isSkillNameProtectedByPolicy(policy, name)) {
      throw new Error(
        `SkillsManager(action=${JSON.stringify(action)}) is blocked: built-in Skill "${name}" is protected and cannot be modified by the model. Create or update a separate user Skill instead.`,
      );
    }
    return;
  }
  if (action === "install" || action === "create" || action === "clawhub_install") {
    assertSkillManagementAllowed(policy, action === "clawhub_install" ? "install" : action);
    const name = typeof payload.name === "string" ? payload.name.trim() : "";
    if (name && (isAlwaysEnabledSkillName(name) || isSkillNameProtectedByPolicy(policy, name))) {
      throw new Error(
        `SkillsManager(action=${JSON.stringify(action)}) is blocked: built-in Skill "${name}" is protected and cannot be modified by the model. Create or update a separate user Skill instead.`,
      );
    }
  }
}

function formatManageSkillResultText(
  result: Awaited<ReturnType<typeof manageSkill>>,
  policy?: SkillAccessPolicy,
) {
  const lines = [
    `SkillsManager action=${result.action}`,
    "pathScheme=skill://<baseDir>/...",
    "Use Read/List/Glob/Grep/Write/Edit/Delete with skill://<baseDir>/... paths for files inside enabled Skills. Use SkillsManager actions for Skill creation, local/GitHub/ClawHub installation, validation, packaging, and deletion.",
  ];

  if (result.action === "list") {
    const skills = result.skills ?? [];
    const invalid = result.invalid ?? [];
    if (isSkillAccessPolicyRestrictive(policy)) {
      lines.push("visible=enabled-skills-only");
    }
    lines.push(`skills=${skills.length}`);
    for (const skill of skills) {
      lines.push(`- ${skill.name} | ${skill.skillFile} | ${skill.description}`);
    }
    if (invalid.length > 0) {
      lines.push(`invalid=${invalid.length}`);
      for (const item of invalid.slice(0, 20)) {
        lines.push(`- invalid ${item.path}: ${item.error}`);
      }
    }
  } else if (result.action === "clawhub_search") {
    const results = result.clawhubResults ?? [];
    lines.push(`results=${results.length}`);
    if (result.clawhubNextCursor) lines.push(`nextCursor=${result.clawhubNextCursor}`);
    for (const item of results) {
      const stats = [
        `downloads=${item.downloads}`,
        `stars=${item.stars}`,
        `installs=${item.installsCurrent}`,
      ].join(" ");
      lines.push(
        `- ${item.slug} | ${item.displayName} | version=${item.latestVersion ?? "latest"} | ${stats}`,
      );
      if (item.summary) lines.push(`  summary=${item.summary}`);
      if (item.ownerHandle) lines.push(`  owner=${item.ownerHandle}`);
      if (item.downloadUrl) lines.push(`  downloadUrl=${item.downloadUrl}`);
      const versionArg = item.latestVersion ? `, version="${item.latestVersion}"` : "";
      const ownerArg = item.ownerHandle ? `, owner="${item.ownerHandle}"` : "";
      lines.push(
        `  install=SkillsManager(action="clawhub_install", slug="${item.slug}"${ownerArg}${versionArg}, conflict="backup")`,
      );
    }
  } else if (result.action === "install" || result.action === "clawhub_install") {
    const installed = result.installed ?? [];
    if (result.action === "clawhub_install") {
      if (result.clawhubSlug) lines.push(`clawhubSlug=${result.clawhubSlug}`);
      if (result.clawhubDownloadUrl) lines.push(`downloadUrl=${result.clawhubDownloadUrl}`);
    }
    lines.push(`installed=${installed.length}`);
    for (const item of installed) {
      lines.push(`- ${item.name} -> ${displaySkillRootPath(result.rootDir, item.target)}`);
      lines.push(`  skillFile=${item.skillFile}`);
      lines.push(`  enabled=true`);
      if (item.backup) lines.push(`  backup=${displaySkillRootPath(result.rootDir, item.backup)}`);
    }
  } else if (result.action === "create" && result.created) {
    lines.push(`created=${result.created.name}`);
    lines.push(`target=${displaySkillRootPath(result.rootDir, result.created.target)}`);
    lines.push(`skillFile=${result.created.skillFile}`);
    lines.push(`enabled=true`);
    if (result.created.backup) {
      lines.push(`backup=${displaySkillRootPath(result.rootDir, result.created.backup)}`);
    }
  } else if (result.action === "validate" && result.validation) {
    lines.push(`name=${result.validation.name}`);
    lines.push(`ok=${result.validation.ok ? "true" : "false"}`);
    if (result.validation.errors.length > 0) {
      lines.push("errors:");
      for (const error of result.validation.errors) lines.push(`- ${error}`);
    }
  } else if (result.action === "package" && result.package) {
    lines.push(`name=${result.package.name}`);
    lines.push(`archive=${displaySkillRootPath(result.rootDir, result.package.archive)}`);
  } else if (result.action === "delete" && result.deleted) {
    lines.push(`deleted=${result.deleted.name}`);
    lines.push(`target=${displaySkillRootPath(result.rootDir, result.deleted.target)}`);
  }

  return lines.join("\n");
}

function buildActionDetails(
  result: Awaited<ReturnType<typeof manageSkill>>,
): SkillsManagerActionResultDetails {
  const validationErrors = result.validation?.errors ?? [];
  const installedBackup = result.installed?.find(
    (item) => typeof item.backup === "string" && item.backup.length > 0,
  )?.backup;
  const backup: string | undefined =
    typeof result.created?.backup === "string"
      ? result.created.backup
      : typeof installedBackup === "string"
        ? installedBackup
        : undefined;
  return {
    kind: "manage_skill",
    action: result.action,
    rootDir: result.rootDir,
    path: result.path ?? undefined,
    skillsCount: result.skills?.length,
    invalidCount: result.invalid?.length,
    installedCount: result.installed?.length,
    createdName: result.created?.name,
    deletedName: result.deleted?.name,
    validationOk: result.validation?.ok,
    packageArchive: result.package?.archive,
    target:
      result.created?.target ??
      result.installed?.[0]?.target ??
      result.validation?.target ??
      result.package?.target ??
      result.deleted?.target,
    backup,
    clawhubResultCount: result.clawhubResults?.length,
    clawhubNextCursor: result.clawhubNextCursor ?? undefined,
    clawhubSlug: result.clawhubSlug ?? result.clawhubResults?.[0]?.slug,
    clawhubDownloadUrl:
      result.clawhubDownloadUrl ?? result.clawhubResults?.[0]?.downloadUrl ?? undefined,
    errors: validationErrors.length > 0 ? validationErrors : undefined,
  };
}

function buildSkillEnvMissingText(gate: { skillName: string; missing: string[] }) {
  return [
    `Skill "${gate.skillName}" is currently unavailable: missing required environment variable(s): ${gate.missing.join(", ")}.`,
    "The app is showing the user a setup card for this (fill the values in the Skill detail page, or adopt existing system environment variables).",
    "Tell the user briefly what is missing, then wait for them to finish configuring before retrying.",
    "Never ask the user to paste secret values into the chat.",
  ].join(" ");
}

export function createSkillTools(
  params: {
    workdir?: string;
    skillAccessPolicy?: SkillAccessPolicy;
    /**
     * 环境变量门禁：按 baseDir 返回该技能未满足的必需变量；null 放行。
     * 命中时 action=read 被拦截，返回 skill_env_missing 结构化结果。
     */
    skillEnvGate?: (baseDir: string) => { skillName: string; missing: string[] } | null;
    onManagedSkillsChanged?: (change: {
      action: "install" | "create" | "delete";
      names: string[];
      baseDirs: string[];
    }) => void | Promise<void>;
  } = {},
): BuiltinToolBundle {
  const skillAccessPolicy = params.skillAccessPolicy;
  const toolSkillsManager: Tool = {
    name: "SkillsManager",
    description:
      "Read and manage Skills in LiveAgent's fixed user Skills directory. Use action=read to read a Skill entry file, action=list to inspect the enabled Skills visible to this chat, action=install to import a local directory/archive/HTTP(S) download/GitHub URL, action=clawhub_search to search or browse ClawHub, action=clawhub_install with a ClawHub slug to download and install a Skill from ClawHub, action=create to create a new Skill from a summarized workflow, action=validate to check an enabled managed Skill, action=package to create a .skill archive, and action=delete to permanently delete an installed user Skill. For files referenced inside an enabled Skill, use Read/List/Grep/Glob/Write/Edit/Delete with skill://<baseDir>/... paths; this allows maintaining or optimizing enabled Skills.",
    parameters: SKILL_MANAGER_PARAMETERS,
  };

  async function executeToolCall(
    toolCall: ToolCall,
    signal?: AbortSignal,
  ): Promise<ToolResultMessage> {
    const now = Date.now();
    if (signal?.aborted) {
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: "Cancelled" }],
        details: {},
        isError: true,
        timestamp: now,
      };
    }

    if (toolCall.name !== "SkillsManager") {
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: `Unknown tool: ${toolCall.name}` }],
        details: {},
        isError: true,
        timestamp: now,
      };
    }

    try {
      const payload = normalizeSkillManagerPayload(
        (toolCall.arguments ?? {}) as Record<string, unknown>,
        { workdir: params.workdir },
      );
      enforceSkillManagerAccessPolicy(payload, skillAccessPolicy);

      if (payload.action === "read" && params.skillEnvGate) {
        const gate = params.skillEnvGate(skillBaseDirFromPath(String(payload.path ?? "")));
        if (gate) {
          const details: SkillsManagerResultDetails = {
            kind: "skill_env_missing",
            skillName: gate.skillName,
            missing: gate.missing,
          };
          return {
            role: "toolResult",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            content: [{ type: "text", text: buildSkillEnvMissingText(gate) }],
            details,
            isError: true,
            timestamp: now,
          };
        }
      }

      const result = await manageSkill(payload);
      const visibleResult = filterManageSkillResult(result, skillAccessPolicy);
      if (
        result.action === "install" ||
        result.action === "create" ||
        result.action === "clawhub_install"
      ) {
        const access = collectManagedSkillAccess(result);
        grantSkillsToAccessPolicy(skillAccessPolicy, access);
        if (access.names.length > 0 || access.baseDirs.length > 0) {
          try {
            await params.onManagedSkillsChanged?.({
              action: result.action === "create" ? "create" : "install",
              names: access.names,
              baseDirs: access.baseDirs,
            });
          } catch (error) {
            console.warn("Failed to auto-enable managed Skills", error);
          }
        }
        notifySkillsDiscoveryUpdated();
      }
      if (result.action === "delete") {
        const deletedName = typeof payload.name === "string" ? payload.name.trim() : "";
        if (deletedName) {
          try {
            await params.onManagedSkillsChanged?.({
              action: "delete",
              names: [deletedName],
              baseDirs: [],
            });
          } catch (error) {
            console.warn("Failed to remove deleted Skill from settings", error);
          }
        }
        notifySkillsDiscoveryUpdated();
      }

      if (visibleResult.action === "read") {
        const path =
          typeof visibleResult.path === "string" ? visibleResult.path : String(payload.path ?? "");
        const content = typeof visibleResult.content === "string" ? visibleResult.content : "";
        const startLine =
          typeof visibleResult.startLine === "number"
            ? visibleResult.startLine
            : (typeof payload.offset === "number" ? payload.offset : 0) + 1;
        const numLines =
          typeof visibleResult.numLines === "number"
            ? visibleResult.numLines
            : countSkillTextLines(content);
        const details: SkillsManagerResultDetails = {
          kind: "read_skill",
          path,
          startLine,
          numLines,
          truncated: visibleResult.truncated === true,
        };
        const header = [
          `SkillsManager: ${path}`,
          `lines=${formatSkillLineWindow(startLine, numLines)}`,
        ].join("\n");
        const body = content || "(empty skill file)";
        const suffix = visibleResult.truncated ? "\n\n[...truncated...]\n" : "";
        const pathRules = buildSkillReadPathRules(path);
        return {
          role: "toolResult",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: [{ type: "text", text: `${header}\n\n${body}${suffix}${pathRules}` }],
          details,
          isError: false,
          timestamp: now,
        };
      }

      const details = buildActionDetails(visibleResult);
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [
          { type: "text", text: formatManageSkillResultText(visibleResult, skillAccessPolicy) },
        ],
        details,
        isError: false,
        timestamp: now,
      };
    } catch (err) {
      const args = (toolCall.arguments ?? {}) as Record<string, unknown>;
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: buildSkillManagerErrorText(args, err) }],
        details: {},
        isError: true,
        timestamp: now,
      };
    }
  }

  return {
    groupId: "skill",
    tools: [toolSkillsManager],
    executeToolCall,
    metadataByName: createBuiltinMetadataMap([
      [
        "SkillsManager",
        {
          groupId: "skill",
          kind: "manage_skill",
          isReadOnly: false,
          displayCategory: "file",
        },
      ],
    ]),
  };
}
