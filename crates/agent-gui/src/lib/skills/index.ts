import { invoke } from "@tauri-apps/api/core";

import { sortSkillsForDisplay } from "./builtin";
import type { ClawHubSkillCard } from "./clawHub";

const SKILLS_DISCOVERY_UPDATED_EVENT = "liveagent:skills-discovery-updated";

export {
  isAlwaysEnabledSkillName,
  isUserSelectableSkill,
  isUserSelectableSkillName,
  mergeAlwaysEnabledSkillNames,
  sortSkillsForDisplay,
} from "./builtin";

export type SkillSummary = {
  /** skill metadata name */
  name: string;
  /** skill metadata description */
  description: string;
  /** relative path to the readable skill file (prefer SKILL.md, fallback skill.json, then README.md) */
  skillFile: string;
  /** relative directory of the skill (from app skills root) */
  baseDir: string;
  /** full README.md content for fallback skills that do not declare metadata */
  inlineContent?: string;
  inlineContentTruncated?: boolean;
  source?: SkillSourceMetadata | null;
};

export type SkillSourceMetadata = {
  registry: string;
  slug: string;
  version?: string | null;
  publishedAt?: number | null;
};

export type SkillDiscovery = {
  rootDir: string;
  skills: SkillSummary[];
};

export type ExplicitSkillMentionReference = {
  name: string;
  skillFile?: string | null;
  baseDir?: string | null;
};

const COMMON_SKILL_MENTION_ENV_VARS = new Set([
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "PWD",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "TERM",
  "XDG_CONFIG_HOME",
]);

function isCommonSkillMentionEnvVar(name: string) {
  const upper = name.toUpperCase();
  return (
    COMMON_SKILL_MENTION_ENV_VARS.has(upper) ||
    (upper.endsWith(":") && COMMON_SKILL_MENTION_ENV_VARS.has(upper.slice(0, -1)))
  );
}

type SystemBuiltinSkillSeedResponse = {
  name: string;
  target: string;
  action: string;
  backup?: string | null;
};
type SystemReadSkillMetadataResponse = {
  name?: string | null;
  description?: string | null;
};
type SystemReadSkillTextResponse = { content: string; truncated: boolean };
export type SkillInstallResult = {
  name: string;
  target: string;
  backup?: string | null;
  skillFile: string;
};
export type SkillInstallJobSnapshot = {
  jobId: string;
  phase: string;
  source: string;
  label?: string | null;
  slug?: string | null;
  version?: string | null;
  downloadedBytes: number;
  totalBytes?: number | null;
  message?: string | null;
  error?: string | null;
  installed?: SkillInstallResult[] | null;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number | null;
};
type SystemManageSkillResponse = {
  action: string;
  rootDir: string;
  path?: string | null;
  content?: string | null;
  truncated?: boolean | null;
  startLine?: number | null;
  numLines?: number | null;
  skills?: Array<{
    name: string;
    description: string;
    target: string;
    skillFile: string;
    baseDir: string;
    source?: SkillSourceMetadata | null;
  }> | null;
  invalid?: Array<{ path: string; error: string }> | null;
  installed?: SkillInstallResult[] | null;
  created?: SkillInstallResult | null;
  validation?: {
    name: string;
    target: string;
    ok: boolean;
    errors: string[];
  } | null;
  package?: {
    name: string;
    target: string;
    archive: string;
  } | null;
  deleted?: {
    name: string;
    target: string;
  } | null;
  installJob?: SkillInstallJobSnapshot | null;
  clawhubResults?: ClawHubSkillCard[] | null;
  clawhubNextCursor?: string | null;
  clawhubSlug?: string | null;
  clawhubDownloadUrl?: string | null;
  external?: ExternalToolScan[] | null;
};

export type ExternalSkillEntry = {
  name: string;
  description: string;
  /** 技能目录绝对路径，可直接作为 install 动作的 source */
  baseDir: string;
  skillFile: string;
};

export type ExternalToolScan = {
  tool: string;
  rootDir: string;
  exists: boolean;
  skills: ExternalSkillEntry[];
  errors: string[];
};

type DiscoverSkillsOptions = {
  force?: boolean;
};

const README_INLINE_READ_LENGTH_LINES = 10000;

let cachedDiscovery: SkillDiscovery | null = null;
let inFlightDiscovery: Promise<SkillDiscovery> | null = null;
let discoveryCacheEpoch = 0;

function normalizeRelPath(path: string) {
  return path.replace(/\\/g, "/");
}

function isSkillMentionNameChar(value: string) {
  return /^[A-Za-z0-9_:-]$/.test(value);
}

export function extractSkillMentionNamesFromText(text: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "$") continue;

    const before = index > 0 ? text[index - 1] : "";
    if (before && !/\s/.test(before)) continue;

    const nameStart = index + 1;
    const first = text[nameStart];
    if (!first || !isSkillMentionNameChar(first)) continue;

    let nameEnd = nameStart + 1;
    while (nameEnd < text.length && isSkillMentionNameChar(text[nameEnd])) {
      nameEnd += 1;
    }

    const name = text.slice(nameStart, nameEnd);
    if (isCommonSkillMentionEnvVar(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
    index = nameEnd - 1;
  }

  return names;
}

export function resolveExplicitSkillMentions(params: {
  text?: string | null;
  structured?: ExplicitSkillMentionReference[] | null;
  enabledSkills: SkillSummary[];
}): SkillSummary[] {
  const enabledSkills = params.enabledSkills;
  if (enabledSkills.length === 0) return [];

  const names: ExplicitSkillMentionReference[] = [];
  const pushName = (item: ExplicitSkillMentionReference | string | null | undefined) => {
    if (!item) return;
    if (typeof item === "string") {
      const name = item.trim();
      if (name) names.push({ name });
      return;
    }
    const name = item.name.trim();
    if (name) {
      names.push({
        name,
        skillFile: item.skillFile ? normalizeRelPath(item.skillFile) : null,
        baseDir: item.baseDir ? normalizeRelPath(item.baseDir) : null,
      });
    }
  };

  for (const item of params.structured ?? []) {
    pushName(item);
  }
  for (const name of extractSkillMentionNamesFromText(params.text ?? "")) {
    pushName(name);
  }

  const byName = new Map<string, SkillSummary[]>();
  const byLowerName = new Map<string, SkillSummary[]>();
  const bySkillFile = new Map<string, SkillSummary>();
  for (const skill of enabledSkills) {
    const nameBucket = byName.get(skill.name) ?? [];
    nameBucket.push(skill);
    byName.set(skill.name, nameBucket);

    const lowerBucket = byLowerName.get(skill.name.toLowerCase()) ?? [];
    lowerBucket.push(skill);
    byLowerName.set(skill.name.toLowerCase(), lowerBucket);
    bySkillFile.set(normalizeRelPath(skill.skillFile), skill);
  }

  const selected: SkillSummary[] = [];
  const seenKeys = new Set<string>();
  const addSkill = (skill: SkillSummary | undefined) => {
    if (!skill) return;
    const key = `${skill.name}\u0000${skill.skillFile}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    selected.push(skill);
  };

  for (const ref of names) {
    const skillFile = ref.skillFile ? normalizeRelPath(ref.skillFile) : "";
    if (skillFile) {
      const skill = bySkillFile.get(skillFile);
      if (skill) {
        addSkill(skill);
        continue;
      }
    }

    const exact = byName.get(ref.name);
    if (exact?.length === 1) {
      addSkill(exact[0]);
      continue;
    }

    const lower = byLowerName.get(ref.name.toLowerCase());
    if (lower?.length === 1) {
      addSkill(lower[0]);
    }
  }

  return selected;
}

function normalizeDisplayPath(path: string) {
  const normalized = normalizeRelPath(path);
  if (normalized.startsWith("//?/UNC/")) {
    return `//${normalized.slice("//?/UNC/".length)}`;
  }
  if (normalized.startsWith("//?/")) {
    return normalized.slice("//?/".length);
  }
  return normalized;
}

function normalizeSkillSourceMetadata(
  source: SkillSourceMetadata | null | undefined,
): SkillSourceMetadata | null {
  if (!source || typeof source.registry !== "string" || typeof source.slug !== "string") {
    return null;
  }
  return {
    registry: source.registry,
    slug: source.slug,
    version: typeof source.version === "string" ? source.version : null,
    publishedAt: typeof source.publishedAt === "number" ? source.publishedAt : null,
  };
}

function isSkillReadmePath(path: string) {
  return /(?:^|\/)readme\.md$/i.test(path);
}

export async function ensureBuiltinSkills() {
  try {
    return await invoke<SystemBuiltinSkillSeedResponse[]>("system_ensure_builtin_skills");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("does not implement invoke")) {
      return [];
    }
    throw error;
  }
}

export function notifySkillsDiscoveryUpdated() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(SKILLS_DISCOVERY_UPDATED_EVENT));
}

export function subscribeSkillsDiscoveryUpdated(listener: () => void) {
  if (typeof window === "undefined") {
    return () => undefined;
  }
  window.addEventListener(SKILLS_DISCOVERY_UPDATED_EVENT, listener);
  return () => window.removeEventListener(SKILLS_DISCOVERY_UPDATED_EVENT, listener);
}

export function invalidateSkillsDiscoveryCache() {
  cachedDiscovery = null;
  inFlightDiscovery = null;
  discoveryCacheEpoch += 1;
}

function sortAndDedupeSkills(skills: SkillSummary[]) {
  skills.sort((a, b) => a.name.localeCompare(b.name));
  const seen = new Set<string>();
  return sortSkillsForDisplay(
    skills.filter((skill) => {
      if (seen.has(skill.name)) return false;
      seen.add(skill.name);
      return true;
    }),
  );
}

async function maybeAttachReadmeFallbackInline(skill: SkillSummary): Promise<SkillSummary> {
  if (!isSkillReadmePath(skill.skillFile)) {
    return skill;
  }

  try {
    const metadata = await invoke<SystemReadSkillMetadataResponse>("system_read_skill_metadata", {
      path: skill.skillFile,
    } as any);
    const hasDeclaredMetadata = Boolean(
      typeof metadata.name === "string" &&
        metadata.name.trim() &&
        typeof metadata.description === "string" &&
        metadata.description.trim(),
    );
    if (hasDeclaredMetadata) {
      return skill;
    }

    const readme = await readSkillText({
      path: skill.skillFile,
      length: README_INLINE_READ_LENGTH_LINES,
    });
    return {
      ...skill,
      inlineContent: readme.content,
      inlineContentTruncated: readme.truncated,
    };
  } catch {
    return skill;
  }
}

async function managedSkillListToDiscovery(
  managed: SystemManageSkillResponse,
): Promise<SkillDiscovery> {
  const rootDir = normalizeDisplayPath(managed.rootDir ?? "");
  const skills: SkillSummary[] = [];
  for (const raw of managed.skills ?? []) {
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    const description = typeof raw.description === "string" ? raw.description.trim() : "";
    const skillFile = typeof raw.skillFile === "string" ? normalizeRelPath(raw.skillFile) : "";
    const baseDir = typeof raw.baseDir === "string" ? normalizeRelPath(raw.baseDir) : "";
    if (!name || !description || !skillFile || !baseDir) continue;
    skills.push(
      await maybeAttachReadmeFallbackInline({
        name,
        description,
        skillFile,
        baseDir,
        source: normalizeSkillSourceMetadata(raw.source),
      }),
    );
  }

  const discovery: SkillDiscovery = {
    rootDir,
    skills: sortAndDedupeSkills(skills),
  };

  if (discovery.skills.length === 0 && (managed.invalid?.length ?? 0) > 0) {
    const invalid = managed.invalid?.[0];
    throw new Error(
      `发现 Skill 元数据无效：${invalid?.path ?? "unknown"}（${invalid?.error ?? "unknown error"}）`,
    );
  }

  return discovery;
}

async function loadSkillsDiscovery(): Promise<SkillDiscovery> {
  await ensureBuiltinSkills();
  return managedSkillListToDiscovery(await manageSkill({ action: "list" }));
}

export async function discoverSkills(options: DiscoverSkillsOptions = {}): Promise<SkillDiscovery> {
  if (options.force) {
    invalidateSkillsDiscoveryCache();
  }
  if (!options.force && cachedDiscovery) {
    return cachedDiscovery;
  }
  if (!options.force && inFlightDiscovery) {
    return inFlightDiscovery;
  }

  const requestEpoch = discoveryCacheEpoch;
  const request = loadSkillsDiscovery().then((discovery) => {
    if (requestEpoch === discoveryCacheEpoch) {
      cachedDiscovery = discovery;
    }
    return discovery;
  });
  inFlightDiscovery = request;
  try {
    return await request;
  } finally {
    if (inFlightDiscovery === request) {
      inFlightDiscovery = null;
    }
  }
}

export async function readSkillText(params: {
  path: string;
  offset?: number;
  length?: number;
}): Promise<SystemReadSkillTextResponse> {
  return invoke<SystemReadSkillTextResponse>("system_read_skill_text", {
    path: params.path,
    offset: params.offset,
    length: params.length,
  } as any);
}

export async function manageSkill(
  params: Record<string, unknown>,
): Promise<SystemManageSkillResponse> {
  const response = await invoke<SystemManageSkillResponse>("system_manage_skill", {
    payload: params,
  } as any);
  const action = typeof params.action === "string" ? params.action : "";
  if (
    action === "install" ||
    action === "create" ||
    action === "delete" ||
    action === "clawhub_install" ||
    (action === "install_status" && response.installJob?.phase === "done")
  ) {
    invalidateSkillsDiscoveryCache();
  }
  return response;
}

export async function scanExternalSkills(): Promise<ExternalToolScan[]> {
  const response = await manageSkill({ action: "scan_external" });
  return response.external ?? [];
}

export async function startSkillInstallJob(
  params: Record<string, unknown>,
): Promise<SkillInstallJobSnapshot> {
  const response = await manageSkill({ ...params, action: "install_start" });
  if (!response.installJob) {
    throw new Error("SkillsManager install_start did not return an install job");
  }
  return response.installJob;
}

export async function getSkillInstallJobStatus(jobId: string): Promise<SkillInstallJobSnapshot> {
  const response = await manageSkill({ action: "install_status", jobId });
  if (!response.installJob) {
    throw new Error("SkillsManager install_status did not return an install job");
  }
  return response.installJob;
}

export async function cancelSkillInstallJob(jobId: string): Promise<SkillInstallJobSnapshot> {
  const response = await manageSkill({ action: "install_cancel", jobId });
  if (!response.installJob) {
    throw new Error("SkillsManager install_cancel did not return an install job");
  }
  return response.installJob;
}

export function buildSkillsSystemPrompt(params: {
  rootDir: string;
  selected: SkillSummary[];
  explicit?: SkillSummary[];
}): string {
  const { selected } = params;
  if (selected.length === 0) return "";
  const explicit = resolveExplicitSkillMentions({
    structured: params.explicit?.map((skill) => ({
      name: skill.name,
      skillFile: skill.skillFile,
      baseDir: skill.baseDir,
    })),
    enabledSkills: selected,
  });

  return [
    "The following Skills are enabled by the user. Skill files are exposed to file tools through skill://<baseDir>/... paths.",
    "",
    "Usage Rules (aligned with Claude Code behavior):",
    "- Skills with metadata use progressive disclosure; their full contents are not automatically injected into context.",
    "- README.md fallback Skills without metadata are loaded inline below because there is no metadata to disclose progressively.",
    "- Only the Skills listed below are enabled for this conversation. SkillsManager(action=list) may be used to review the enabled Skills visible to this chat, but it must not be used to enumerate or infer other installed Skills.",
    "- Only when you determine that a metadata Skill is genuinely needed should you call SkillsManager with action=read to read the full Skill file and then follow its workflow exactly.",
    "- SkillsManager.path uses the skillFile below and may point to SKILL.md, skill.md, skill.json, or README.md.",
    '- For files referenced inside an enabled Skill, use file tools with skill://<baseDir>/... paths, for example Read(path="skill://<baseDir>/references/guide.md"), List, Glob, Grep, Write, Edit, or Delete.',
    "- You may update files inside enabled Skills when the user asks you to optimize or maintain them. Create, install, search/install from ClawHub, validate, package, or delete user Skills through SkillsManager actions.",
    "- Absolute local paths, ~/..., and file:// forms are auto-normalized by file tools; prefer skill://<baseDir>/... for enabled Skill files.",
    "- If Skill content contains shell snippets that read Skill files with cat/ls/find/grep, route those reads through Read/List/Glob/Grep instead of Bash.",
    "- Do not guess a Skill's exact instructions or script paths before reading the Skill file.",
    "- Relative paths inside a Skill (scripts/, references/, assets/, and so on) are resolved relative to baseDir.",
    "- If a Skill contains the {baseDir} placeholder, interpret it as the baseDir value in the metadata below (relative to the Skills root directory).",
    explicit.length > 0
      ? [
          "",
          "Explicitly mentioned this turn:",
          "- The user explicitly mentioned the following enabled Skills with `$skill-name` in this turn.",
          "- Treat these mentions as user intent to prioritize those Skills. Read and follow the mentioned Skill instructions before acting when they are relevant.",
          "- `$` mentions never grant access to disabled Skills; only the enabled Skills listed in this prompt are available.",
          ...explicit.map(
            (skill) => `- ${skill.name} (skillFile: ${skill.skillFile}, baseDir: ${skill.baseDir})`,
          ),
        ].join("\n")
      : "",
    "",
    "Skills:",
    ...selected.map((s) =>
      [
        `- name: ${s.name}`,
        `  description: ${s.description}`,
        `  skillFile: ${s.skillFile}`,
        `  baseDir: ${s.baseDir}`,
        s.inlineContent !== undefined
          ? [
              `  loadedFrom: README.md without metadata`,
              `  truncated: ${s.inlineContentTruncated ? "true" : "false"}`,
              "  content:",
              "<README.md>",
              s.inlineContent || "(empty README.md)",
              "</README.md>",
            ].join("\n")
          : "",
      ].join("\n"),
    ),
  ].join("\n");
}
