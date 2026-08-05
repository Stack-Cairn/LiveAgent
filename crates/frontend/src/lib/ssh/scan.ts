import type { SshHostConfig } from "../settings";
import { invokeFs } from "../tools/fsBackend";

type FsRoot = {
  id: string;
  path: string;
  kind: "home" | "root" | "drive";
  label: string;
};

type FsRootsResponse = {
  roots: FsRoot[];
};

type FsListResponse = {
  entries: Array<{ path: string; kind: "file" | "dir" }>;
};

type FsReadEditableTextResponse = {
  content: string;
};

export type SshImportCandidate = Omit<SshHostConfig, "id"> & {
  id: string;
  source: string;
  duplicate: boolean;
};

export type SshScanResult = {
  homePath: string;
  sshDirPath: string;
  keyFiles: string[];
  candidates: SshImportCandidate[];
};

type ParsedSshHost = {
  alias: string;
  host: string;
  username: string;
  port: number;
  identityFile: string;
};

const SSH_CONFIG_PATH = ".ssh/config";
const SSH_DIR_PATH = ".ssh";
const DEFAULT_SSH_PORT = 22;
type SshPathProfile = "windows" | "posix";

function normalizePath(path: string) {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function joinPath(base: string, child: string) {
  const normalizedBase = normalizePath(base);
  const normalizedChild = child.replace(/^\/+/, "");
  return normalizedChild ? `${normalizedBase}/${normalizedChild}` : normalizedBase;
}

function pathProfileFromHome(homePath: string): SshPathProfile {
  const trimmed = homePath.trim();
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) return "windows";
  if (/^[\\/]{2}/.test(trimmed)) return "windows";
  if (trimmed.includes("\\")) return "windows";
  return "posix";
}

function stripWrappingQuotes(path: string) {
  const trimmed = path.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  return (first === `"` && last === `"`) || (first === "'" && last === "'")
    ? trimmed.slice(1, -1)
    : trimmed;
}

function isWindowsAbsolutePath(path: string) {
  if (/^[\\/]{2}\?[\\/]/.test(path)) return true;
  if (/^[A-Za-z]:[\\/]/.test(path)) return true;
  return /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+/.test(path);
}

function joinIdentityPath(homePath: string, child: string, profile: SshPathProfile) {
  if (profile === "windows") {
    const separator = homePath.includes("\\") ? "\\" : "/";
    const normalizedBase = homePath.replace(/[\\/]+$/, "");
    const normalizedChild = child.replace(/^[\\/]+/, "");
    return normalizedChild ? `${normalizedBase}${separator}${normalizedChild}` : normalizedBase;
  }
  const normalizedBase = homePath.replace(/\/+$/, "");
  const normalizedChild = child.replace(/^\/+/, "");
  return normalizedChild ? `${normalizedBase}/${normalizedChild}` : normalizedBase;
}

function basename(path: string) {
  const normalized = normalizePath(path);
  return normalized.slice(normalized.lastIndexOf("/") + 1) || normalized;
}

function parsePort(value: string | undefined) {
  const port = Number(value ?? "");
  if (!Number.isFinite(port)) return DEFAULT_SSH_PORT;
  const normalized = Math.floor(port);
  return normalized >= 1 && normalized <= 65535 ? normalized : DEFAULT_SSH_PORT;
}

function isWildcardHost(alias: string) {
  return alias.includes("*") || alias.includes("?") || alias.startsWith("!");
}

function stripInlineComment(line: string) {
  const index = line.indexOf("#");
  return index >= 0 ? line.slice(0, index).trim() : line.trim();
}

function parseSshConfig(content: string): ParsedSshHost[] {
  const hosts: ParsedSshHost[] = [];
  let aliases: string[] = [];
  let options = new Map<string, string>();

  function flush() {
    const hostAliases = aliases.filter((alias) => alias && !isWildcardHost(alias));
    for (const alias of hostAliases) {
      const hostName = options.get("hostname")?.trim() || alias;
      hosts.push({
        alias,
        host: hostName,
        username: options.get("user")?.trim() || "",
        port: parsePort(options.get("port")),
        identityFile: options.get("identityfile")?.trim() || "",
      });
    }
    aliases = [];
    options = new Map<string, string>();
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const line = stripInlineComment(rawLine);
    if (!line) continue;
    const [rawKey = "", ...rest] = line.split(/\s+/);
    const key = rawKey.toLowerCase();
    const value = rest.join(" ").trim();
    if (key === "host") {
      flush();
      aliases = rest.map((item) => item.trim()).filter(Boolean);
      continue;
    }
    if (aliases.length > 0 && key && value) {
      options.set(key, value);
    }
  }
  flush();

  return hosts;
}

function isLikelyPrivateKeyPath(path: string) {
  const name = basename(path);
  if (!name || name.endsWith(".pub")) return false;
  if (
    ["config", "known_hosts", "known_hosts.old", "authorized_keys", "authorized_keys2"].includes(
      name,
    )
  ) {
    return false;
  }
  return name.startsWith("id_") || !name.includes(".");
}

function isPrivateKeyContent(content: string) {
  return /^-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/m.test(content.trim());
}

export function expandIdentityPath(homePath: string, path: string) {
  const profile = pathProfileFromHome(homePath);
  const trimmed = stripWrappingQuotes(path);
  if (!trimmed) return "";
  if (profile === "windows") {
    if (isWindowsAbsolutePath(trimmed)) return trimmed;
    if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
      return joinIdentityPath(homePath, trimmed.slice(2), profile);
    }
    if (trimmed.startsWith("$HOME/") || trimmed.startsWith("$HOME\\")) {
      return joinIdentityPath(homePath, trimmed.slice(6), profile);
    }
    if (trimmed.startsWith("${HOME}/") || trimmed.startsWith("${HOME}\\")) {
      return joinIdentityPath(homePath, trimmed.slice(8), profile);
    }
    if (/^%USERPROFILE%[\\/]/i.test(trimmed)) {
      return joinIdentityPath(homePath, trimmed.slice("%USERPROFILE%".length), profile);
    }
    if (/^%HOMEDRIVE%%HOMEPATH%[\\/]/i.test(trimmed)) {
      return joinIdentityPath(homePath, trimmed.slice("%HOMEDRIVE%%HOMEPATH%".length), profile);
    }
    if (trimmed.startsWith("/") || trimmed.startsWith("\\")) return trimmed;
    return joinIdentityPath(homePath, trimmed, profile);
  }
  if (trimmed.startsWith("~/")) return joinIdentityPath(homePath, trimmed.slice(2), profile);
  if (trimmed.startsWith("$HOME/")) return joinIdentityPath(homePath, trimmed.slice(6), profile);
  if (trimmed.startsWith("${HOME}/")) return joinIdentityPath(homePath, trimmed.slice(8), profile);
  if (trimmed.startsWith("/")) return trimmed.replace(/\/+$/, "");
  return joinIdentityPath(homePath, trimmed, profile);
}

function toHomeRelativePath(homePath: string, path: string) {
  const profile = pathProfileFromHome(homePath);
  const home =
    profile === "windows" ? `${normalizePath(homePath)}/` : `${homePath.replace(/\/+$/, "")}/`;
  const normalized = profile === "windows" ? normalizePath(path) : path;
  return normalized.startsWith(home) ? normalized.slice(home.length) : "";
}

async function readHomeFile(homePath: string, relativePath: string) {
  const response = await invokeFs<FsReadEditableTextResponse>("fs_read_editable_text", {
    workdir: homePath,
    path: relativePath,
  });
  return response.content;
}

async function readOptionalHomeFile(homePath: string, relativePath: string) {
  try {
    return await readHomeFile(homePath, relativePath);
  } catch {
    return "";
  }
}

async function findHomePath() {
  const response = await invokeFs<FsRootsResponse>("fs_roots", {});
  const home =
    response.roots.find((root) => root.kind === "home") ??
    response.roots.find((root) => root.id === "home");
  return home?.path?.trim() ?? "";
}

async function listSshDirectory(homePath: string) {
  try {
    const response = await invokeFs<FsListResponse>("fs_list", {
      workdir: homePath,
      path: SSH_DIR_PATH,
      depth: 1,
      offset: 0,
      max_results: 300,
    });
    return Array.isArray(response.entries) ? response.entries : [];
  } catch {
    return [];
  }
}

export function sshHostIdentityKey(host: Pick<SshHostConfig, "host" | "port" | "username">) {
  return `${host.host.trim().toLowerCase()}|${host.port || DEFAULT_SSH_PORT}|${host.username
    .trim()
    .toLowerCase()}`;
}

export async function scanSshImportCandidates(
  existingHosts: SshHostConfig[] = [],
): Promise<SshScanResult> {
  const homePath = await findHomePath();
  if (!homePath) {
    throw new Error("无法定位用户目录。");
  }

  const entries = await listSshDirectory(homePath);
  const configContent = await readOptionalHomeFile(homePath, SSH_CONFIG_PATH);
  const parsedHosts = parseSshConfig(configContent);
  const keyEntries = entries
    .filter((entry) => entry.kind === "file" && isLikelyPrivateKeyPath(entry.path))
    .map((entry) => entry.path);

  const keyContentByPath = new Map<string, string>();
  for (const keyPath of keyEntries) {
    const content = await readOptionalHomeFile(homePath, keyPath);
    if (isPrivateKeyContent(content)) {
      keyContentByPath.set(normalizePath(keyPath), content.trim());
      keyContentByPath.set(joinPath(homePath, keyPath), content.trim());
    }
  }

  const existingKeys = new Set(existingHosts.map(sshHostIdentityKey));
  const candidates = parsedHosts.map((host) => {
    const identityPath = expandIdentityPath(homePath, host.identityFile);
    const identityRelativePath = identityPath ? toHomeRelativePath(homePath, identityPath) : "";
    const privateKey =
      keyContentByPath.get(identityPath) ??
      (identityRelativePath ? keyContentByPath.get(normalizePath(identityRelativePath)) : "") ??
      "";
    const authType = privateKey || identityPath ? "privateKey" : "password";
    const candidate: SshImportCandidate = {
      id: `ssh-import-${host.alias}-${host.host}-${host.port}`,
      name: host.alias,
      description: "Imported from ~/.ssh/config",
      host: host.host,
      port: host.port,
      username: host.username,
      authType,
      password: "",
      passwordConfigured: false,
      privateKey,
      privateKeyPath: identityPath,
      privateKeyConfigured: privateKey.length > 0 || identityPath.length > 0,
      privateKeyPassphrase: "",
      privateKeyPassphraseConfigured: false,
      proxy: {
        type: "socks5",
        url: "",
        port: 0,
        username: "",
        password: "",
        passwordConfigured: false,
      },
      source: SSH_CONFIG_PATH,
      duplicate: false,
    };
    return {
      ...candidate,
      duplicate: existingKeys.has(sshHostIdentityKey(candidate)),
    };
  });

  return {
    homePath,
    sshDirPath: joinPath(homePath, SSH_DIR_PATH),
    keyFiles: [...keyContentByPath.keys()]
      .filter((path) => !path.startsWith(normalizePath(homePath)))
      .sort(),
    candidates,
  };
}
