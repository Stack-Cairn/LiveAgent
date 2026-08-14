function normalizeUnicode(value: string) {
  return typeof value.normalize === "function" ? value.normalize("NFC") : value;
}

function collapseDuplicateSeparators(value: string) {
  if (value.startsWith("//")) {
    return `//${value.slice(2).replace(/\/{2,}/g, "/")}`;
  }
  return value.replace(/\/{2,}/g, "/");
}

export function normalizeWindowsExtendedPrefix(value: string) {
  if (/^\/\/[?.]\/UNC\//i.test(value)) {
    return `//${value.slice("//?/UNC/".length)}`;
  }
  if (/^\/\/[?.]\/[a-zA-Z]:\//.test(value)) {
    return value.slice("//?/".length);
  }
  return value;
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

export function normalizeRawPathInput(input: unknown, label: string) {
  if (typeof input !== "string") return "";
  const value = normalizeWindowsExtendedPrefix(normalizeUnicode(input.trim()).replace(/\\/g, "/"));
  if (value.includes("\0")) {
    throw new Error(`${label} contains a NUL byte and cannot be resolved`);
  }
  return value;
}

export function normalizeRelativePathUnicode(value: string) {
  return normalizeUnicode(value);
}

export function isWindowsDrivePath(value: string) {
  return /^[a-zA-Z]:\//.test(value);
}

export function isAbsolutePath(value: string) {
  return value.startsWith("/") || isWindowsDrivePath(value);
}

export function isUncPath(value: string) {
  return value.startsWith("//");
}

export function normalizeRootPath(rootDir: string) {
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
