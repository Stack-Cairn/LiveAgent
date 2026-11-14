/**
 * Sign-in state import into the built-in browser: wire types for the host's
 * `embedded_browser_import_sources` / `embedded_browser_import_cookies` commands and the pure
 * helpers the import dialog uses. Cookie values never reach the renderer; the
 * host only returns counts.
 */

export type BrowserImportSource = {
  /** Stable browser id: "chrome" | "edge" | "chromium" | "brave". */
  browser: string;
  browserName: string;
  /** Profile directory name ("Default", "Profile 1"…); the import lookup key. */
  profileDir: string;
  /** Profile name shown in the source browser's own UI. */
  displayName: string;
};

export type BrowserImportSkipReason =
  | "expired"
  | "appBoundEncryption"
  | "keyUnavailable"
  | "decryptFailed"
  | "unsupportedEncryption";

export type BrowserImportSummary = {
  total: number;
  imported: number;
  failed: number;
  skipped: Array<{ reason: BrowserImportSkipReason | string; count: number }>;
  keyError: string | null;
  errors: string[];
};

export type BrowserImportRequest = {
  browser: string;
  profileDir: string;
  /** Empty or absent imports every site. */
  domains?: string[];
};

export const BROWSER_IMPORT_SKIP_REASONS: readonly BrowserImportSkipReason[] = [
  "expired",
  "appBoundEncryption",
  "keyUnavailable",
  "decryptFailed",
  "unsupportedEncryption",
];

export function browserImportSourceKey(
  source: Pick<BrowserImportSource, "browser" | "profileDir">,
) {
  return `${source.browser}:${source.profileDir}`;
}

export function browserImportSourceLabel(source: BrowserImportSource) {
  const profile = source.displayName.trim() || source.profileDir;
  return `${source.browserName} · ${profile}`;
}

const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * Parses the optional site filter ("github.com, .example.org https://a.test/x")
 * into bare lowercase host names. URLs are reduced to their host; entries that
 * are not plausible host names are dropped. Empty means "all sites".
 */
export function parseBrowserImportDomains(input: string): string[] {
  const domains: string[] = [];
  for (const raw of input.split(/[\s,;，、]+/)) {
    let entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry.includes("://")) {
      try {
        entry = new URL(entry).hostname;
      } catch {
        continue;
      }
    } else {
      entry = entry.split(/[/?#]/, 1)[0]?.replace(/:\d+$/, "") ?? "";
    }
    entry = entry.replace(/^\.+/, "").replace(/\.+$/, "");
    if (!entry || entry.length > 253) continue;
    const labels = entry.split(".");
    if (labels.some((label) => !label || label.length > 63 || !DOMAIN_LABEL.test(label))) continue;
    if (!domains.includes(entry)) domains.push(entry);
  }
  return domains;
}

export type BrowserImportOutcome = "success" | "partial" | "nothing" | "failed";

export type BrowserImportResultView = {
  outcome: BrowserImportOutcome;
  imported: number;
  failed: number;
  skippedTotal: number;
  /** Non-zero skip buckets, largest first; reasons are i18n key suffixes. */
  skipped: Array<{ reason: string; count: number }>;
  keyError: string | null;
};

/** Normalises a host summary into what the dialog renders. */
export function describeBrowserImportResult(
  summary: BrowserImportSummary,
): BrowserImportResultView {
  const skipped = summary.skipped
    .filter((entry) => entry.count > 0)
    .map((entry) => ({ reason: entry.reason, count: entry.count }))
    .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason));
  const skippedTotal = skipped.reduce((sum, entry) => sum + entry.count, 0);
  const keyError = summary.keyError?.trim() || null;
  let outcome: BrowserImportOutcome;
  if (summary.imported > 0) {
    outcome = summary.failed > 0 || skippedTotal > 0 || keyError ? "partial" : "success";
  } else if (summary.total === 0) {
    outcome = "nothing";
  } else {
    outcome = "failed";
  }
  return {
    outcome,
    imported: summary.imported,
    failed: summary.failed,
    skippedTotal,
    skipped,
    keyError,
  };
}

/** Translation key for a skip reason; unknown codes share a generic label. */
export function browserImportSkipReasonKey(reason: string) {
  return (BROWSER_IMPORT_SKIP_REASONS as readonly string[]).includes(reason)
    ? `projectTools.browserImportSkip.${reason}`
    : "projectTools.browserImportSkip.other";
}
