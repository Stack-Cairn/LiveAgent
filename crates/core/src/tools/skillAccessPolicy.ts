import { isAlwaysEnabledSkillName } from "../skills/builtin";

export type SkillAccessPolicy = {
  allowedSkillNames?: readonly string[];
  allowedSkillBaseDirs?: readonly string[];
  protectedSkillNames?: readonly string[];
  protectedSkillBaseDirs?: readonly string[];
  allowSkillInventory?: boolean;
  allowSkillManagement?: boolean;
  allowSkillMutation?: boolean;
};

type SkillLike = {
  name?: string;
  baseDir?: string;
  skillFile?: string;
  target?: string;
  path?: string;
};

function normalizeRelPath(path: string) {
  return path
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/g, "");
}

function normalizeName(name: string) {
  return name.trim();
}

export function normalizeSkillBaseDir(path: string) {
  const normalized = normalizeRelPath(path);
  return normalized.split("/").find(Boolean) ?? "";
}

function normalizePolicyBaseDirs(policy?: SkillAccessPolicy) {
  if (!Array.isArray(policy?.allowedSkillBaseDirs)) return null;
  return new Set(
    policy.allowedSkillBaseDirs
      .map((baseDir) => normalizeSkillBaseDir(String(baseDir)))
      .filter(Boolean),
  );
}

function normalizePolicyNames(policy?: SkillAccessPolicy) {
  if (!Array.isArray(policy?.allowedSkillNames)) return null;
  return new Set(
    policy.allowedSkillNames.map((name) => normalizeName(String(name))).filter(Boolean),
  );
}

function normalizeProtectedSkillNames(policy?: SkillAccessPolicy) {
  if (!Array.isArray(policy?.protectedSkillNames)) return new Set<string>();
  return new Set(
    policy.protectedSkillNames.map((name) => normalizeName(String(name))).filter(Boolean),
  );
}

function normalizeProtectedSkillBaseDirs(policy?: SkillAccessPolicy) {
  if (!Array.isArray(policy?.protectedSkillBaseDirs)) return new Set<string>();
  return new Set(
    policy.protectedSkillBaseDirs
      .map((baseDir) => normalizeSkillBaseDir(String(baseDir)))
      .filter(Boolean),
  );
}

export function isSkillNameProtectedByPolicy(policy: SkillAccessPolicy | undefined, name: string) {
  return normalizeProtectedSkillNames(policy).has(normalizeName(name));
}

export function isSkillAccessPolicyRestrictive(policy?: SkillAccessPolicy) {
  return Array.isArray(policy?.allowedSkillBaseDirs);
}

export function isSkillPathAllowedByPolicy(policy: SkillAccessPolicy | undefined, path: string) {
  const allowedBaseDirs = normalizePolicyBaseDirs(policy);
  if (!allowedBaseDirs) return true;
  const baseDir = normalizeSkillBaseDir(path);
  return Boolean(baseDir && allowedBaseDirs.has(baseDir));
}

export function isSkillNameAllowedByPolicy(policy: SkillAccessPolicy | undefined, name: string) {
  const allowedNames = normalizePolicyNames(policy);
  if (!allowedNames) return true;
  const normalizedName = normalizeName(name);
  return Boolean(normalizedName && allowedNames.has(normalizedName));
}

function appendUniqueNormalized(
  current: readonly string[] | undefined,
  values: readonly string[],
  normalize: (value: string) => string,
) {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of [...(current ?? []), ...values]) {
    const normalized = normalize(String(value));
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export function grantSkillsToAccessPolicy(
  policy: SkillAccessPolicy | undefined,
  grant: {
    names?: readonly string[];
    baseDirs?: readonly string[];
  },
) {
  if (!policy || !isSkillAccessPolicyRestrictive(policy)) return;
  policy.allowedSkillNames = appendUniqueNormalized(
    policy.allowedSkillNames,
    grant.names ?? [],
    normalizeName,
  );
  policy.allowedSkillBaseDirs = appendUniqueNormalized(
    policy.allowedSkillBaseDirs,
    grant.baseDirs ?? [],
    normalizeSkillBaseDir,
  );
}

export function buildSkillAccessDeniedMessage(params: {
  operation: string;
  path?: string;
  name?: string;
  allowedSkillNames?: readonly string[];
}) {
  const target = params.name
    ? `Skill "${params.name}"`
    : params.path
      ? `Skill path "${params.path}"`
      : "The fixed Skills root";
  const allowed = Array.from(params.allowedSkillNames ?? [])
    .map((name) => String(name).trim())
    .filter(Boolean);
  const allowedText =
    allowed.length > 0
      ? `Allowed Skills in this conversation: ${allowed.join(", ")}.`
      : "No Skills are enabled for file access in this conversation.";
  return [
    `${params.operation} is blocked: ${target} is not enabled for this conversation.`,
    allowedText,
    "Enable the Skill in the chat Skills selector before reading, searching, or running files from it.",
    "Do not bypass this with Bash, absolute paths, find /, or ~/.liveagent/skills.",
  ].join(" ");
}

export function assertSkillPathAllowedByPolicy(
  policy: SkillAccessPolicy | undefined,
  path: string,
  operation: string,
) {
  if (isSkillPathAllowedByPolicy(policy, path)) return;
  throw new Error(
    buildSkillAccessDeniedMessage({
      operation,
      path,
      allowedSkillNames: policy?.allowedSkillNames,
    }),
  );
}

export function assertSkillNameAllowedByPolicy(
  policy: SkillAccessPolicy | undefined,
  name: string,
  operation: string,
) {
  if (isSkillNameAllowedByPolicy(policy, name)) return;
  throw new Error(
    buildSkillAccessDeniedMessage({
      operation,
      name,
      allowedSkillNames: policy?.allowedSkillNames,
    }),
  );
}

export function filterSkillsByAccessPolicy<T extends SkillLike>(
  policy: SkillAccessPolicy | undefined,
  skills: readonly T[],
) {
  if (!isSkillAccessPolicyRestrictive(policy)) return [...skills];
  return skills.filter((skill) => {
    const name = typeof skill.name === "string" ? skill.name : "";
    if (name && isSkillNameAllowedByPolicy(policy, name)) return true;
    for (const candidate of [skill.baseDir, skill.skillFile, skill.target, skill.path]) {
      if (typeof candidate === "string" && isSkillPathAllowedByPolicy(policy, candidate)) {
        return true;
      }
    }
    return false;
  });
}

export function assertSkillInventoryAllowed(policy: SkillAccessPolicy | undefined) {
  if (!isSkillAccessPolicyRestrictive(policy) || policy?.allowSkillInventory === true) return;
  throw new Error(
    buildSkillAccessDeniedMessage({
      operation: "SkillsManager(action=list)",
      allowedSkillNames: policy?.allowedSkillNames,
    }),
  );
}

export function assertSkillManagementAllowed(
  policy: SkillAccessPolicy | undefined,
  action: string,
) {
  if (!isSkillAccessPolicyRestrictive(policy) || policy?.allowSkillManagement === true) return;
  throw new Error(
    [
      `SkillsManager(action=${JSON.stringify(action)}) is blocked in this conversation.`,
      "Create, install, validate, package, and delete Skills from Settings > Skills or an explicit management flow.",
      "Ordinary chat runs may only use Skills that are enabled in the chat Skills selector.",
    ].join(" "),
  );
}

export function assertSkillMutationAllowed(
  policy: SkillAccessPolicy | undefined,
  operation: string,
  path?: string,
) {
  const baseDir = typeof path === "string" ? normalizeSkillBaseDir(path) : "";
  if (
    baseDir &&
    (isAlwaysEnabledSkillName(baseDir) || normalizeProtectedSkillBaseDirs(policy).has(baseDir))
  ) {
    throw new Error(
      [
        `${operation} is blocked: built-in Skill "${baseDir}" is protected and cannot be modified by the model.`,
        "Built-in Skills may be read and used, but their files are managed by LiveAgent.",
        "Create or update a separate user Skill instead.",
      ].join(" "),
    );
  }
  if (!isSkillAccessPolicyRestrictive(policy) || policy?.allowSkillMutation === true) return;
  throw new Error(
    [
      `${operation} is blocked: ${
        path ? `Skill path "${path}"` : "the fixed Skills root"
      } is not writable in this conversation.`,
      "Enable the Skill in the chat Skills selector before changing files inside it.",
      "If this is a new Skill or package-level install, use SkillsManager with the skills-creator or skills-installer flow.",
    ].join(" "),
  );
}
