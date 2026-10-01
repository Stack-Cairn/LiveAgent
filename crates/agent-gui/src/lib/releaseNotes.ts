export type ReleaseNotesSource = {
  body?: string | null;
  currentVersion?: string | null;
  releaseName?: string | null;
  releaseTag?: string | null;
  version?: string | null;
};

export function releaseTitle(release?: ReleaseNotesSource) {
  if (!release) return "";
  return (
    release.releaseName?.trim() ||
    release.releaseTag?.trim() ||
    release.version?.trim() ||
    release.currentVersion?.trim() ||
    ""
  );
}

function normalizeTitle(value: string) {
  return value
    .replace(/^#+\s*/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function releaseNotesBody(release?: ReleaseNotesSource) {
  const body = release?.body?.replace(/^\s*(?:<!--[\s\S]*?-->\s*)+/, "").trim();
  if (!body) return "";

  const title = normalizeTitle(releaseTitle(release));
  if (!title) return body;

  const lines = body.split(/\r?\n/);
  const firstContentIndex = lines.findIndex((line) => line.trim());
  if (firstContentIndex < 0) return "";

  const firstContentLine = lines[firstContentIndex].trim();
  if (/^#\s+/.test(firstContentLine) && normalizeTitle(firstContentLine) === title) {
    return lines
      .slice(firstContentIndex + 1)
      .join("\n")
      .trim();
  }

  return body;
}
