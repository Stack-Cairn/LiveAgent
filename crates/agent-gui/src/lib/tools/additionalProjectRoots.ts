import { isWindowsDrivePath, normalizeRootPath } from "./pathNormalization";

export type AdditionalProjectRootAccess = "read" | "write";

/**
 * A turn-level capability granted by the native project settings layer.
 * Additional roots extend structured file tools only; shell/process tools do
 * not receive this capability.
 */
export type AdditionalProjectRoot = {
  id: string;
  alias: string;
  path: string;
  access: AdditionalProjectRootAccess;
};

export type NormalizedAdditionalProjectRoot = AdditionalProjectRoot & {
  normalizedPath: string;
  aliasLookupKey: string;
};

const RESERVED_ALIASES = new Set(["workspace", "skill", "uploads", "external"]);

export function normalizeAdditionalRoots(
  roots: readonly AdditionalProjectRoot[] | undefined,
): NormalizedAdditionalProjectRoot[] {
  const normalized: NormalizedAdditionalProjectRoot[] = [];
  const seenIds = new Set<string>();
  const seenAliases = new Set<string>();
  const seenPaths = new Set<string>();

  for (const root of roots ?? []) {
    const id = String(root?.id || "").trim();
    const alias = String(root?.alias || "").trim();
    const aliasLookupKey = alias.toLowerCase();
    if (!id) throw new Error("Additional project root id cannot be empty");
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(alias)) {
      throw new Error(
        `Additional project root alias must match [a-z][a-z0-9_-]{0,31}: ${alias || "<empty>"}`,
      );
    }
    if (RESERVED_ALIASES.has(alias)) {
      throw new Error(`Additional project root alias is reserved: ${alias}`);
    }
    if (root.access !== "read" && root.access !== "write") {
      throw new Error(`Additional project root ${alias} has an unsupported access mode`);
    }
    const normalizedPath = normalizeRootPath(root.path);
    const pathLookupKey = isWindowsDrivePath(normalizedPath)
      ? normalizedPath.toLowerCase()
      : normalizedPath;
    if (seenIds.has(id)) throw new Error(`Duplicate additional project root id: ${id}`);
    if (seenAliases.has(aliasLookupKey)) {
      throw new Error(`Duplicate additional project root alias: ${alias}`);
    }
    if (seenPaths.has(pathLookupKey)) {
      throw new Error(`Duplicate additional project root path: ${normalizedPath}`);
    }
    seenIds.add(id);
    seenAliases.add(aliasLookupKey);
    seenPaths.add(pathLookupKey);
    normalized.push({
      id,
      alias,
      path: root.path,
      access: root.access,
      normalizedPath,
      aliasLookupKey,
    });
  }

  return normalized;
}
