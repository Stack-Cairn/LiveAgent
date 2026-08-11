// Logical `skill://<baseDir>/<relativePath>` paths: the form file tools report
// for files inside installed Skills, and the form the fs backend resolves
// against the Skills root instead of the workspace root. UI surfaces that key
// off the workspace root (file tree, git review) must exclude these paths.

const SKILL_PATH_SCHEME = "skill://";

const SKILL_PATH_PATTERN = /^skill:\/\/([^/]+)(?:\/(.*))?$/i;

export function isSkillPath(path: string) {
  return path.trim().toLowerCase().startsWith(SKILL_PATH_SCHEME);
}

export type SkillPathScope = {
  /** Skills-root-relative directory that owns the file, e.g. `html-mini-game`. */
  baseDir: string;
  /** Path of the file inside `baseDir`; empty when the path names the Skill itself. */
  relativePath: string;
};

export function parseSkillPath(path: string): SkillPathScope | null {
  const match = SKILL_PATH_PATTERN.exec(path.trim().replace(/\\/g, "/"));
  if (!match) return null;
  return { baseDir: match[1], relativePath: match[2] ?? "" };
}

export function formatSkillPath(baseDir: string, relativePath: string) {
  return `${SKILL_PATH_SCHEME}${baseDir}/${relativePath}`;
}
