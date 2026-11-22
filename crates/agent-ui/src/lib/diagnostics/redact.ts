/**
 * Redaction for diagnostics bundles.
 *
 * Everything that leaves the app in a diagnostics bundle or a copied summary
 * passes through here. The rules are deliberately greedy: a false positive
 * costs a little debugging context, a false negative leaks a credential.
 *
 * Two layers:
 * - `redactText` scrubs free-form text (logs, error messages, URLs).
 * - `redactJson` walks structured data, drops values under secret-looking or
 *   content-carrying keys outright and runs `redactText` over every other
 *   string.
 *
 * Every replacement is counted per category so the export dialog can show the
 * user what was removed without showing the removed values.
 */

export type RedactionCategory =
  | "privateKey"
  | "authHeader"
  | "cookie"
  | "urlCredential"
  | "urlSecretParam"
  | "secretAssignment"
  | "apiKey"
  | "jwt"
  | "highEntropy"
  | "email"
  | "homePath"
  | "secretField"
  | "contentField";

export const REDACTION_CATEGORIES: readonly RedactionCategory[] = [
  "privateKey",
  "authHeader",
  "cookie",
  "urlCredential",
  "urlSecretParam",
  "secretAssignment",
  "apiKey",
  "jwt",
  "highEntropy",
  "email",
  "homePath",
  "secretField",
  "contentField",
];

export type RedactionCounts = Record<RedactionCategory, number>;

export function emptyRedactionCounts(): RedactionCounts {
  return Object.fromEntries(
    REDACTION_CATEGORIES.map((category) => [category, 0]),
  ) as RedactionCounts;
}

export function mergeRedactionCounts(
  target: RedactionCounts,
  source: RedactionCounts,
): RedactionCounts {
  for (const category of REDACTION_CATEGORIES) target[category] += source[category];
  return target;
}

export function totalRedactions(counts: RedactionCounts): number {
  return REDACTION_CATEGORIES.reduce((sum, category) => sum + counts[category], 0);
}

export type RedactOptions = {
  /** Absolute home directories to fold to `~` (the current user's, as known). */
  homeDirs?: readonly string[];
  /** Counts are added here; a fresh counter is used when omitted. */
  counts?: RedactionCounts;
};

export const REDACTED = "[REDACTED]";

const isAlreadyRedacted = (value: string) => value.startsWith("[REDACTED");

type TextRule = {
  category: RedactionCategory;
  pattern: RegExp;
  replace: (match: string, ...groups: string[]) => string | null;
};

// Key fragments that mark an assignment or field as a credential. Matched
// against a key normalised to lowercase without `_`/`-`/`.`.
const SECRET_KEY_FRAGMENTS = [
  "apikey",
  "token",
  "secret",
  "password",
  "passwd",
  "passphrase",
  "authorization",
  "cookie",
  "credential",
  "privatekey",
  "accesskey",
  "sessionid",
  "signature",
  "bearer",
];
const SECRET_KEY_EXACT = new Set(["auth", "pwd", "pass", "sig", "xapikey", "proxyauthorization"]);

// Keys whose values are user content (messages, prompts, files). They are
// dropped whatever they contain.
const CONTENT_KEYS = new Set([
  "prompt",
  "prompts",
  "systemprompt",
  "instructions",
  "content",
  "contents",
  "messages",
  "text",
  "body",
  "input",
  "output",
  "filecontent",
  "filecontents",
  "transcript",
  "history",
]);

// Containers whose values are header/env maps: names are kept for context,
// every value is dropped.
const VALUE_MAP_KEYS = new Set(["headers", "customheaders", "env", "environment"]);

function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[_\-.\s]/g, "");
}

export function isSecretKey(key: string): boolean {
  const normalised = normaliseKey(key);
  if (!normalised) return false;
  if (SECRET_KEY_EXACT.has(normalised)) return true;
  // "...Configured"/"...Count" flags describe a secret without holding it.
  if (/(configured|count|present|set|enabled|length|limit|max|tokens)$/.test(normalised)) {
    return false;
  }
  return SECRET_KEY_FRAGMENTS.some((fragment) => normalised.includes(fragment));
}

export function isContentKey(key: string): boolean {
  return CONTENT_KEYS.has(normaliseKey(key));
}

const SECRET_NAME_SOURCE =
  "[A-Za-z0-9_.-]*?(?:api[_-]?key|apikey|token|secret|password|passwd|passphrase|credentials?|private[_-]?key|access[_-]?key|session[_-]?id|client[_-]?secret|auth)[A-Za-z0-9_.-]*";

function hasMixedClasses(value: string): boolean {
  const upper = /[A-Z]/.test(value);
  const lower = /[a-z]/.test(value);
  const digit = /[0-9]/.test(value);
  return (upper && lower && digit) || (upper && digit && value.length >= 40);
}

const TEXT_RULES: TextRule[] = [
  {
    category: "privateKey",
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
    replace: () => "[REDACTED:private-key]",
  },
  {
    // `Authorization: Bearer x`, `"authorization":"Basic x"`, `Proxy-Authorization=...`
    category: "authHeader",
    pattern:
      /((?:proxy[-_])?authorization|x-api-key|api-key|x-goog-api-key|x-auth-token)(["']?\s*[:=]\s*["']?)([^"'\r\n,}]+)/gi,
    replace: (_match, name, separator, value) =>
      isAlreadyRedacted(value) ? null : `${name}${separator}${REDACTED}`,
  },
  {
    category: "authHeader",
    pattern: /\b(Bearer|Basic|Token|Digest)\s+([A-Za-z0-9._~+/=:-]{6,})/g,
    replace: (_match, scheme, value) => {
      if (isAlreadyRedacted(value)) return null;
      // Prose such as "Token expired" is not a credential.
      if (!/\d/.test(value) && value.length < 16) return null;
      return `${scheme} ${REDACTED}`;
    },
  },
  {
    category: "cookie",
    pattern: /\b((?:set-)?cookie)(["']?\s*[:=]\s*["']?)([^"'\r\n]+)/gi,
    replace: (_match, name, separator, value) =>
      isAlreadyRedacted(value) ? null : `${name}${separator}${REDACTED}`,
  },
  {
    // userinfo in any scheme://user:pass@host or scheme://token@host
    category: "urlCredential",
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@?#"'<>]+)@/gi,
    replace: (_match, scheme, userinfo) =>
      isAlreadyRedacted(userinfo) ? null : `${scheme}${REDACTED}@`,
  },
  {
    category: "urlSecretParam",
    pattern:
      /([?&;](?:[A-Za-z0-9_.-]*(?:api[_-]?key|apikey|token|secret|password|passwd|signature|credential|auth)[A-Za-z0-9_.-]*|key|sig|code|pwd|session)=)([^&#\s"'<>]+)/gi,
    replace: (_match, prefix, value) => (isAlreadyRedacted(value) ? null : `${prefix}${REDACTED}`),
  },
  {
    // Quoted key/value pairs inside JSON-ish log text: "apiKey": "value"
    category: "secretAssignment",
    pattern: new RegExp(
      `(["'])(${SECRET_NAME_SOURCE})\\1(\\s*[:=]\\s*)(["'])((?:\\\\.|(?!\\4)[^\\\\])*)\\4`,
      "gi",
    ),
    replace: (_match, quote, name, separator, valueQuote, value) => {
      if (!value || isAlreadyRedacted(value) || !isSecretKey(name)) return null;
      return `${quote}${name}${quote}${separator}${valueQuote}${REDACTED}${valueQuote}`;
    },
  },
  {
    // Env dumps and CLI flags: OPENAI_API_KEY=..., export TOKEN="...", --api-key value
    category: "secretAssignment",
    pattern: new RegExp(
      `(^|[\\s;,(\\[{]|--?)(${SECRET_NAME_SOURCE})(\\s*=\\s*|\\s+(?=["']?[A-Za-z0-9_./+=-]{8,}))(["']?)([^\\s"',;)\\]}]+)\\4`,
      "gim",
    ),
    replace: (_match, lead, name, separator, quote, value) => {
      if (!value || isAlreadyRedacted(value) || !isSecretKey(name)) return null;
      // `--token value` style flags only when the separator is whitespace and
      // the lead is a dash; plain words followed by text are prose.
      if (!separator.includes("=") && !lead.startsWith("-") && !name.startsWith("-")) return null;
      return `${lead}${name}${separator}${quote}${REDACTED}${quote}`;
    },
  },
  {
    category: "apiKey",
    pattern:
      /\b(?:sk-(?:ant-|proj-|or-|live-|test-)?[A-Za-z0-9_-]{16,}|(?:AKIA|ASIA)[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|glpat-[A-Za-z0-9_-]{16,}|hf_[A-Za-z0-9]{24,}|(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|npm_[A-Za-z0-9]{30,})\b/g,
    replace: () => "[REDACTED:key]",
  },
  {
    category: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g,
    replace: () => "[REDACTED:jwt]",
  },
  {
    // Long opaque tokens mixing cases and digits. Hex-only strings (commit
    // revisions, hashes, uuids) do not mix cases and survive.
    category: "highEntropy",
    pattern: /(?<![A-Za-z0-9_-])[A-Za-z0-9_\-+]{32,}={0,2}(?![A-Za-z0-9_-])/g,
    replace: (match) => {
      if (/^[0-9a-f-]+$/i.test(match) && !/[a-f].*[A-F]|[A-F].*[a-f]/.test(match)) return null;
      return hasMixedClasses(match) ? "[REDACTED:token]" : null;
    },
  },
  {
    category: "email",
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
    replace: () => "[REDACTED:email]",
  },
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function homeVariants(home: string): string[] {
  const trimmed = home.replace(/[\\/]+$/, "");
  if (trimmed.length < 2) return [];
  const variants = new Set([trimmed]);
  variants.add(trimmed.replaceAll("\\", "/"));
  variants.add(trimmed.replaceAll("/", "\\"));
  // JSON-escaped Windows paths: C:\\Users\\name
  variants.add(trimmed.replaceAll("\\", "\\\\"));
  return [...variants].sort((left, right) => right.length - left.length);
}

const GENERIC_HOME_PATTERNS = [
  // macOS / Linux / WSL home directories, including /private/var-style roots.
  /(?<![A-Za-z0-9_~])(?:\/private)?\/(?:Users|home)\/(?!Shared\b)[^/\s"'`:;,)\]}]+/g,
  /(?<![A-Za-z0-9_~])\/root(?=\/|\b)/g,
  // Windows: C:\Users\name, C:/Users/name, JSON-escaped C:\\Users\\name
  /\b[A-Za-z]:(?:\\\\|\\|\/)Users(?:\\\\|\\|\/)[^\\/\s"'`:;,)\]}]+/gi,
];

function redactHomePaths(
  text: string,
  homeDirs: readonly string[],
  counts: RedactionCounts,
): string {
  let result = text;
  for (const home of homeDirs) {
    for (const variant of homeVariants(home)) {
      // A drive letter in front of a separator-led variant belongs to the same path.
      const drive = /^[\\/]/.test(variant) ? "(?:[A-Za-z]:)?" : "";
      const pattern = new RegExp(
        `${drive}${escapeRegExp(variant)}(?=$|[\\\\/\\s"'\`:;,)\\]}])`,
        "g",
      );
      result = result.replace(pattern, () => {
        counts.homePath += 1;
        return "~";
      });
    }
  }
  for (const pattern of GENERIC_HOME_PATTERNS) {
    result = result.replace(pattern, () => {
      counts.homePath += 1;
      return "~";
    });
  }
  return result;
}

/** Scrubs credentials, emails and home paths from free-form text. */
export function redactText(text: string, options: RedactOptions = {}): string {
  const counts = options.counts ?? emptyRedactionCounts();
  let result = text;
  for (const rule of TEXT_RULES) {
    rule.pattern.lastIndex = 0;
    result = result.replace(rule.pattern, (match: string, ...rest: unknown[]) => {
      const groups = rest.slice(0, -2).map((group) => (typeof group === "string" ? group : ""));
      const replacement = rule.replace(match, ...groups);
      if (replacement === null) return match;
      counts[rule.category] += 1;
      return replacement;
    });
  }
  return redactHomePaths(result, options.homeDirs ?? [], counts);
}

function isHeaderPair(value: Record<string, unknown>): boolean {
  return typeof value.key === "string" && "value" in value && Object.keys(value).length <= 3;
}

/**
 * Deep-copies structured data with secrets and content removed. Booleans,
 * numbers and null are kept under secret keys (they describe, not hold, a
 * credential: `apiKeyConfigured: true`, `maxTokens: 4096`).
 */
export function redactJson(value: unknown, options: RedactOptions = {}): unknown {
  const counts = options.counts ?? emptyRedactionCounts();
  const textOptions = { ...options, counts };
  const seen = new WeakSet<object>();
  const visit = (node: unknown, depth: number): unknown => {
    if (typeof node === "string") return redactText(node, textOptions);
    if (node === null || typeof node !== "object") return node;
    if (depth > 32 || seen.has(node)) return "[REDACTED:depth]";
    seen.add(node);
    if (Array.isArray(node)) return node.map((item) => visit(item, depth + 1));
    const record = node as Record<string, unknown>;
    if (isHeaderPair(record)) {
      const name = String(record.key);
      counts.secretField += record.value === "" || record.value == null ? 0 : 1;
      return { ...record, key: redactText(name, textOptions), value: REDACTED };
    }
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(record)) {
      const safeKey = redactText(key, textOptions);
      if (
        VALUE_MAP_KEYS.has(normaliseKey(key)) &&
        child &&
        typeof child === "object" &&
        !Array.isArray(child)
      ) {
        const names: Record<string, string> = {};
        for (const [name, headerValue] of Object.entries(child as Record<string, unknown>)) {
          if (headerValue !== "" && headerValue != null) counts.secretField += 1;
          names[redactText(name, textOptions)] = REDACTED;
        }
        output[safeKey] = names;
        continue;
      }
      if (isContentKey(key) && child != null && child !== "") {
        counts.contentField += 1;
        output[safeKey] = "[REDACTED:content]";
        continue;
      }
      if (
        isSecretKey(key) &&
        child != null &&
        typeof child !== "boolean" &&
        typeof child !== "number"
      ) {
        if (child !== "" && !(Array.isArray(child) && child.length === 0)) counts.secretField += 1;
        output[safeKey] = child === "" ? "" : REDACTED;
        continue;
      }
      output[safeKey] = visit(child, depth + 1);
    }
    return output;
  };
  return visit(value, 0);
}

/** Keeps scheme, host and port of a URL; drops userinfo, path, query and fragment. */
export function urlOrigin(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    return `${url.protocol}//${url.host}`;
  } catch {
    return redactText(trimmed.split(/[?#]/)[0] ?? "");
  }
}

/** Keeps scheme, host, port and path of a URL; drops userinfo, query and fragment. */
export function urlWithoutSecrets(raw: string, options: RedactOptions = {}): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    const path = url.pathname === "/" ? "" : url.pathname;
    return redactText(`${url.protocol}//${url.host}${path}`, options);
  } catch {
    return redactText(trimmed.split(/[?#]/)[0] ?? "", options);
  }
}
