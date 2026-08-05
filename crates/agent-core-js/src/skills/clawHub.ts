import { hubFetch } from "../hubFetch";

export type ClawHubSort = "downloads" | "stars" | "installs" | "updated" | "newest";

export type ClawHubSkillCard = {
  slug: string;
  displayName: string;
  summary: string;
  /** ClawHub 上的自由标签，用于本地分类与卡片标签展示。 */
  topics: string[];
  latestVersion: string | null;
  downloads: number;
  stars: number;
  installsCurrent: number;
  updatedAt: number | null;
  ownerHandle: string | null;
  webUrl?: string | null;
  downloadUrl?: string | null;
};

export type ClawHubSkillDetail = ClawHubSkillCard & {
  createdAt: number | null;
  latestVersionCreatedAt: number | null;
  latestVersionChangelog: string | null;
  license: string | null;
  ownerDisplayName: string | null;
  ownerImage: string | null;
  supportedOs: string[];
  supportedSystems: string[];
  moderationStatus: string | null;
};

export type ClawHubListResponse = {
  items: ClawHubSkillCard[];
  nextCursor: string | null;
};

const CLAWHUB_API_BASE = "https://clawhub.ai";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => asString(item)).filter((item): item is string => Boolean(item))
    : [];
}

function buildClawHubWebUrl(ownerHandle: string | null, slug: string) {
  if (!ownerHandle) return null;
  return `${CLAWHUB_API_BASE}/${encodeURIComponent(ownerHandle)}/${encodeURIComponent(slug)}`;
}

export function buildClawHubSkillKey(skill: Pick<ClawHubSkillCard, "slug" | "ownerHandle">) {
  const slug = skill.slug.trim().toLowerCase();
  const ownerHandle = skill.ownerHandle?.trim().replace(/^@+/, "").toLowerCase();
  return `clawhub:${ownerHandle || "?"}/${slug}`;
}

export function normalizeClawHubSkillCard(raw: unknown): ClawHubSkillCard | null {
  const item = asRecord(raw);
  const slug = asString(item.slug);
  if (!slug) return null;
  const stats = asRecord(item.stats);
  const latestVersion = asRecord(item.latestVersion);
  const tags = asRecord(item.tags);
  const owner = asRecord(item.owner);
  const ownerHandle = asString(item.ownerHandle) ?? asString(owner.handle);

  return {
    slug,
    displayName: asString(item.displayName) ?? slug,
    summary: asString(item.summary) ?? "",
    topics: asStringArray(item.topics),
    latestVersion:
      asString(latestVersion.version) ?? asString(tags.latest) ?? asString(item.version),
    downloads: asNullableNumber(item.downloads) ?? asNullableNumber(stats.downloads) ?? 0,
    stars: asNullableNumber(item.stars) ?? asNullableNumber(stats.stars) ?? 0,
    installsCurrent:
      asNullableNumber(item.installsCurrent) ??
      asNullableNumber(item.installs) ??
      asNullableNumber(stats.installsCurrent) ??
      asNullableNumber(stats.installs) ??
      0,
    updatedAt: asNullableNumber(item.updatedAt),
    ownerHandle,
    webUrl: asString(item.webUrl) ?? buildClawHubWebUrl(ownerHandle, slug),
    downloadUrl: asString(item.downloadUrl) ?? buildClawHubDownloadUrl(slug, ownerHandle),
  };
}

function normalizeSkillDetail(raw: unknown): ClawHubSkillDetail | null {
  const payload = asRecord(raw);
  const skill = asRecord(payload.skill);
  const item = Object.keys(skill).length > 0 ? skill : payload;
  const latestVersion = asRecord(payload.latestVersion ?? item.latestVersion);
  const owner = asRecord(payload.owner ?? item.owner);
  const metadata = asRecord(payload.metadata ?? item.metadata);
  const moderation = asRecord(payload.moderation ?? item.moderation);
  const card = normalizeClawHubSkillCard({
    ...item,
    latestVersion,
    owner,
  });
  if (!card) return null;

  return {
    ...card,
    createdAt: asNullableNumber(item.createdAt),
    latestVersionCreatedAt: asNullableNumber(latestVersion.createdAt),
    latestVersionChangelog: asString(latestVersion.changelog),
    license: asString(latestVersion.license),
    ownerDisplayName: asString(owner.displayName),
    ownerImage: asString(owner.image),
    supportedOs: asStringArray(metadata.os),
    supportedSystems: asStringArray(metadata.systems),
    moderationStatus:
      asString(moderation.status) ?? asString(moderation.result) ?? asString(moderation.state),
  };
}

export class ClawHubHttpError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    const detail = body.trim();
    super(`ClawHub request failed with HTTP ${status}${detail ? `: ${detail}` : ""}`);
    this.name = "ClawHubHttpError";
    this.status = status;
    this.body = body;
  }
}

async function fetchClawHubJson(url: URL): Promise<unknown> {
  // 经 hubFetch 出网：桌面端由本地反代按应用代理配置转发，WebUI 浏览器直连。
  const response = await hubFetch(url.toString(), {
    headers: { Accept: "application/json" },
  });
  const body = await response.text();
  if (!response.ok) {
    throw new ClawHubHttpError(response.status, body);
  }
  return JSON.parse(body) as unknown;
}

export async function listClawHubSkills(params: {
  sort: ClawHubSort;
  cursor?: string | null;
  limit?: number;
}): Promise<ClawHubListResponse> {
  const url = new URL("/api/v1/skills", CLAWHUB_API_BASE);
  url.searchParams.set("limit", String(params.limit ?? 24));
  url.searchParams.set("sort", params.sort);
  url.searchParams.set("nonSuspiciousOnly", "true");
  if (params.cursor) {
    url.searchParams.set("cursor", params.cursor);
  }

  const json = asRecord(await fetchClawHubJson(url));
  const items = Array.isArray(json.items)
    ? json.items
        .map(normalizeClawHubSkillCard)
        .filter((item): item is ClawHubSkillCard => Boolean(item))
    : [];
  return {
    items,
    nextCursor: asString(json.nextCursor),
  };
}

export async function searchClawHubSkills(params: {
  query: string;
  limit?: number;
}): Promise<ClawHubSkillCard[]> {
  const url = new URL("/api/v1/search", CLAWHUB_API_BASE);
  url.searchParams.set("q", params.query);
  url.searchParams.set("limit", String(params.limit ?? 24));
  url.searchParams.set("nonSuspiciousOnly", "true");

  const json = asRecord(await fetchClawHubJson(url));
  return Array.isArray(json.results)
    ? json.results
        .map(normalizeClawHubSkillCard)
        .filter((item): item is ClawHubSkillCard => Boolean(item))
    : [];
}

function narrowOwnerCandidates(
  candidates: ClawHubSkillCard[],
  predicate: (candidate: ClawHubSkillCard) => boolean,
) {
  const narrowed = candidates.filter(predicate);
  return narrowed.length > 0 ? narrowed : candidates;
}

export function selectClawHubOwnerCandidate(
  skill: ClawHubSkillCard,
  candidates: ClawHubSkillCard[],
): ClawHubSkillCard | null {
  let exact = candidates.filter(
    (candidate) =>
      candidate.slug.toLowerCase() === skill.slug.toLowerCase() && Boolean(candidate.ownerHandle),
  );
  if (exact.length === 1) return exact[0];
  if (exact.length === 0) return null;

  if (skill.updatedAt !== null) {
    exact = narrowOwnerCandidates(exact, (candidate) => candidate.updatedAt === skill.updatedAt);
    if (exact.length === 1) return exact[0];
  }
  if (skill.latestVersion) {
    exact = narrowOwnerCandidates(
      exact,
      (candidate) => candidate.latestVersion === skill.latestVersion,
    );
    if (exact.length === 1) return exact[0];
  }
  if (skill.downloads > 0) {
    exact = narrowOwnerCandidates(exact, (candidate) => candidate.downloads === skill.downloads);
    if (exact.length === 1) return exact[0];
  }
  if (skill.summary) {
    exact = narrowOwnerCandidates(exact, (candidate) => candidate.summary === skill.summary);
    if (exact.length === 1) return exact[0];
  }
  if (skill.displayName) {
    exact = narrowOwnerCandidates(
      exact,
      (candidate) => candidate.displayName === skill.displayName,
    );
  }
  return exact.length === 1 ? exact[0] : null;
}

export async function resolveClawHubSkillOwner(skill: ClawHubSkillCard): Promise<ClawHubSkillCard> {
  if (skill.ownerHandle) return skill;

  const candidates = await searchClawHubSkills({ query: skill.slug, limit: 50 });
  const resolved = selectClawHubOwnerCandidate(skill, candidates);
  if (!resolved?.ownerHandle) {
    throw new Error(
      `ClawHub skill "${skill.slug}" has multiple publishers, but the catalog item does not identify one`,
    );
  }

  return {
    ...skill,
    ownerHandle: resolved.ownerHandle,
    webUrl: resolved.webUrl ?? buildClawHubWebUrl(resolved.ownerHandle, skill.slug),
    downloadUrl: buildClawHubDownloadUrl(skill.slug, resolved.ownerHandle),
  };
}

export async function getClawHubSkillDetail(
  slug: string,
  ownerHandle?: string | null,
): Promise<ClawHubSkillDetail> {
  const url = new URL(`/api/v1/skills/${encodeURIComponent(slug)}`, CLAWHUB_API_BASE);
  // ClawHub 对重名 slug 返回 409，须带 ownerHandle 消歧。
  if (ownerHandle) {
    url.searchParams.set("ownerHandle", ownerHandle);
  }
  const detail = normalizeSkillDetail(await fetchClawHubJson(url));
  if (!detail) {
    throw new Error("ClawHub skill detail not found");
  }
  return detail;
}

export function buildClawHubDownloadUrl(slug: string, ownerHandle?: string | null) {
  const url = new URL("/api/v1/download", CLAWHUB_API_BASE);
  url.searchParams.set("slug", slug);
  url.searchParams.set("tag", "latest");
  if (ownerHandle) {
    url.searchParams.set("ownerHandle", ownerHandle);
  }
  return url.toString();
}
