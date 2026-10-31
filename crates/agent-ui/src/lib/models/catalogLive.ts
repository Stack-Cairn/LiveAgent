import { sha256Hex } from "../trajectory/sha256";
import type {
  CatalogInputModality,
  CatalogModelEntry,
  CatalogProviderId,
  CatalogThinkingLevel,
} from "./catalog.generated";
import {
  applyRuntimeModelCatalog,
  MODEL_CATALOG,
  MODEL_CATALOG_SNAPSHOT_DATE,
  type RuntimeModelCatalog,
} from "./modelCatalog";

// ---------------------------------------------------------------------------
// 模型目录运行期同步（model-catalog.v1.json）
// ---------------------------------------------------------------------------
// 内置快照（catalog.generated.ts）随发版更新；本模块在运行期拉取同一生成器
// 产出的 JSON（publish-model-catalog.yml 定时发布到 data/model-catalog 分支），
// 校验通过后经 applyRuntimeModelCatalog 生效。客户端只校验、不重算：合并与
// 归一化规则只在 scripts/generate-model-catalog.mjs 里存在一份。
//
// 优先级（见 docs/design/2026-10-30-model-catalog-live-sync.md）：用户配置 >
// 供应商声明 > 运行期目录 > 内置快照 > 供应商兜底。任何校验失败整份丢弃，
// 保留上一份可用数据（磁盘缓存或内置快照）；补充层永远不能比现状更糟。
// GUI/WebUI 共用；保持 react-free，node 测试直接加载。

export const CATALOG_LIVE_SCHEMA_VERSION = 1;

export const CATALOG_LIVE_DEFAULT_URL =
  "https://raw.githubusercontent.com/Stack-Cairn/LiveAgent/data/model-catalog/model-catalog.v1.json";

/** Gateway 代理（同源、无需鉴权）：国内部署可经 Gateway 的出站代理回源。 */
export const CATALOG_LIVE_GATEWAY_PATH = "/api/public/model-catalog";

/** 默认刷新间隔与发布频率（每 6 小时）一致。 */
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30_000;

const STORAGE_KEY = "liveagent.catalogLive.v1";
const STORAGE_SCHEMA_VERSION = 1;

// 与生成器 THINKING_LEVELS / INPUT_MODALITIES 同值；未知取值整份拒收。
const THINKING_LEVELS: ReadonlySet<string> = new Set<CatalogThinkingLevel>([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const INPUT_MODALITIES: ReadonlySet<string> = new Set<CatalogInputModality>([
  "text",
  "image",
  "audio",
  "video",
  "pdf",
]);
const KNOWN_SECTIONS = Object.keys(MODEL_CATALOG) as CatalogProviderId[];
const SNAPSHOT_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type CatalogLiveRejection =
  | "not-object"
  | "schema-version"
  | "snapshot-date"
  | "sha256"
  | "section-minimum"
  | "entry"
  | "duplicate-id";

export type ParsedRuntimeCatalog = RuntimeModelCatalog & { sha256: string };

export type CatalogLiveParseResult =
  | { ok: true; catalog: ParsedRuntimeCatalog }
  | { ok: false; reason: CatalogLiveRejection; detail: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function parseEntry(raw: unknown): CatalogModelEntry | string {
  if (!isRecord(raw)) return "entry is not an object";
  const { id, contextWindow, maxOutputToken, inputModalities, thinking } = raw;
  if (typeof id !== "string" || !id.trim() || id.trim() !== id) return "invalid id";
  if (!isPositiveInteger(contextWindow)) return `${id}: invalid contextWindow`;
  if (!isPositiveInteger(maxOutputToken)) return `${id}: invalid maxOutputToken`;
  if (maxOutputToken >= contextWindow) return `${id}: maxOutputToken must be below contextWindow`;
  const entry: CatalogModelEntry = { id, contextWindow, maxOutputToken };
  if (inputModalities !== undefined) {
    if (
      !Array.isArray(inputModalities) ||
      inputModalities.length === 0 ||
      !inputModalities.every((value) => typeof value === "string" && INPUT_MODALITIES.has(value))
    ) {
      return `${id}: invalid inputModalities`;
    }
    entry.inputModalities = inputModalities as CatalogInputModality[];
  }
  if (thinking !== undefined) {
    if (
      !isRecord(thinking) ||
      typeof thinking.off !== "boolean" ||
      !Array.isArray(thinking.levels) ||
      !thinking.levels.every((value) => typeof value === "string" && THINKING_LEVELS.has(value))
    ) {
      return `${id}: invalid thinking`;
    }
    entry.thinking = { levels: thinking.levels as CatalogThinkingLevel[], off: thinking.off };
  }
  return entry;
}

/**
 * 六项校验（设计 §7.2），任一不满足整份拒收：
 * 1 schemaVersion 匹配；2 snapshotDate 不早于内置快照；3 sections 的 sha256 一致；
 * 4 已知分区条目数不少于 minimums；5 条目字段合法；6 id 按小写全局唯一。
 * 未知分区与条目上的未知字段丢弃（新增可选字段不递增 schemaVersion）。
 */
export function parseRuntimeCatalog(
  raw: unknown,
  options?: { bundledSnapshotDate?: string },
): CatalogLiveParseResult {
  const reject = (reason: CatalogLiveRejection, detail: string): CatalogLiveParseResult => ({
    ok: false,
    reason,
    detail,
  });
  if (!isRecord(raw)) return reject("not-object", "document is not an object");
  if (raw.schemaVersion !== CATALOG_LIVE_SCHEMA_VERSION) {
    return reject("schema-version", `unsupported schemaVersion ${String(raw.schemaVersion)}`);
  }
  const bundledSnapshotDate = options?.bundledSnapshotDate ?? MODEL_CATALOG_SNAPSHOT_DATE;
  const { snapshotDate } = raw;
  if (typeof snapshotDate !== "string" || !SNAPSHOT_DATE_PATTERN.test(snapshotDate)) {
    return reject("snapshot-date", "invalid snapshotDate");
  }
  if (snapshotDate < bundledSnapshotDate) {
    return reject(
      "snapshot-date",
      `snapshot ${snapshotDate} is older than bundled ${bundledSnapshotDate}`,
    );
  }
  const { sections, minimums, sha256 } = raw;
  if (!isRecord(sections)) return reject("entry", "sections is not an object");
  if (typeof sha256 !== "string" || sha256Hex(JSON.stringify(sections)) !== sha256) {
    return reject("sha256", "sections hash mismatch");
  }

  const parsed: RuntimeModelCatalog["sections"] = {};
  const seenIds = new Map<string, string>();
  let knownSectionCount = 0;
  for (const section of KNOWN_SECTIONS) {
    const rawEntries = sections[section];
    if (rawEntries === undefined) continue;
    if (!Array.isArray(rawEntries)) return reject("entry", `${section}: not an array`);
    knownSectionCount += 1;
    const declaredMinimum = isRecord(minimums) ? minimums[section] : undefined;
    const minimum = isPositiveInteger(declaredMinimum) ? declaredMinimum : 1;
    if (rawEntries.length < minimum) {
      return reject(
        "section-minimum",
        `${section}: ${rawEntries.length} models, expected >= ${minimum}`,
      );
    }
    const entries: CatalogModelEntry[] = [];
    for (const rawEntry of rawEntries) {
      const entry = parseEntry(rawEntry);
      if (typeof entry === "string") return reject("entry", `${section}: ${entry}`);
      const lower = entry.id.toLowerCase();
      const owner = seenIds.get(lower);
      if (owner) return reject("duplicate-id", `${entry.id} appears in ${owner} and ${section}`);
      seenIds.set(lower, section);
      entries.push(entry);
    }
    parsed[section] = entries;
  }
  if (knownSectionCount === 0) return reject("entry", "no known sections");
  return { ok: true, catalog: { snapshotDate, sections: parsed, sha256 } };
}

// ---------------------------------------------------------------------------
// 版本信号
// ---------------------------------------------------------------------------
let liveVersion = 0;
const listeners = new Set<() => void>();

export function getCatalogLiveVersion(): number {
  return liveVersion;
}

export function subscribeCatalogLive(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export type CatalogLiveStatus = {
  /** bundled = 仅内置快照；cache = 磁盘缓存；network = 本次运行拉取。 */
  origin: "bundled" | "cache" | "network";
  snapshotDate: string;
  sha256?: string;
  url?: string;
  fetchedAt?: number;
};

let status: CatalogLiveStatus = { origin: "bundled", snapshotDate: MODEL_CATALOG_SNAPSHOT_DATE };
let lastFetchedAt = 0;
let inflight: Promise<boolean> | null = null;
let sources: readonly string[] = [CATALOG_LIVE_DEFAULT_URL];

export function getCatalogLiveStatus(): CatalogLiveStatus {
  return status;
}

/**
 * 设置拉取地址顺序（第一个成功且通过校验的生效）。WebUI 把同源 Gateway 代理放在
 * 默认地址之前；空列表回到默认地址。
 */
export function configureCatalogLiveSources(urls: readonly string[]): void {
  const next: string[] = [];
  for (const url of urls) {
    const trimmed = url.trim();
    if (trimmed && !next.includes(trimmed)) next.push(trimmed);
  }
  sources = next.length > 0 ? next : [CATALOG_LIVE_DEFAULT_URL];
}

function activate(
  catalog: ParsedRuntimeCatalog,
  next: Omit<CatalogLiveStatus, "snapshotDate" | "sha256">,
): void {
  const changed = status.sha256 !== catalog.sha256;
  status = { ...next, snapshotDate: catalog.snapshotDate, sha256: catalog.sha256 };
  if (!changed) return;
  applyRuntimeModelCatalog(catalog);
  liveVersion += 1;
  for (const listener of listeners) listener();
}

// ---------------------------------------------------------------------------
// 持久化（localStorage 存整份文档，读出后重新校验；约 35KB）
// ---------------------------------------------------------------------------
type StoredPayload = { v: number; fetchedAt: number; url: string; document: unknown };

function readStoredPayload(): StoredPayload | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredPayload>;
    if (
      parsed.v !== STORAGE_SCHEMA_VERSION ||
      typeof parsed.fetchedAt !== "number" ||
      typeof parsed.url !== "string"
    ) {
      return null;
    }
    return parsed as StoredPayload;
  } catch {
    return null;
  }
}

function writeStoredPayload(payload: StoredPayload): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // 配额/隐私模式：只影响冷启动热身，不影响本次生效。
  }
}

function isFresh(ttlMs: number): boolean {
  return status.origin !== "bundled" && Date.now() - lastFetchedAt < ttlMs;
}

async function fetchDocument(url: string): Promise<unknown> {
  // cache: "no-cache" 让浏览器用自身 HTTP 缓存的 ETag 做条件请求：未变化时只走
  // 一次 304，且不加自定义请求头，跨域读取 raw 不触发预检。
  const response = await fetch(url, {
    cache: "no-cache",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/**
 * 拉取并生效运行期目录。幂等：TTL 内直接命中；并发调用共享同一 in-flight。
 * 冷启动先同步用磁盘缓存热身（在第一个 await 之前完成，设置加载因此能用上），
 * 再按地址顺序拉取。全部失败静默返回 false，保留现有数据。
 */
export async function loadCatalogLiveSupplement(options?: {
  force?: boolean;
  ttlMs?: number;
}): Promise<boolean> {
  const ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
  if (!options?.force && isFresh(ttlMs)) return true;
  if (inflight) return inflight;
  inflight = (async () => {
    if (status.origin === "bundled") {
      const stored = readStoredPayload();
      const cached = stored ? parseRuntimeCatalog(stored.document) : undefined;
      if (stored && cached?.ok) {
        lastFetchedAt = stored.fetchedAt;
        activate(cached.catalog, { origin: "cache", url: stored.url, fetchedAt: stored.fetchedAt });
        if (!options?.force && isFresh(ttlMs)) return true;
      }
    }
    for (const url of sources) {
      try {
        const document = await fetchDocument(url);
        const result = parseRuntimeCatalog(document);
        if (!result.ok) {
          console.warn(`model catalog from ${url} rejected (${result.reason}): ${result.detail}`);
          continue;
        }
        const fetchedAt = Date.now();
        lastFetchedAt = fetchedAt;
        activate(result.catalog, { origin: "network", url, fetchedAt });
        writeStoredPayload({ v: STORAGE_SCHEMA_VERSION, fetchedAt, url, document });
        return true;
      } catch {
        // 离线/超时/非 JSON：试下一个地址。
      }
    }
    return false;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

const DEFAULT_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

/**
 * 长时间运行的宿主定期检查，页面重新可见时也检查一次；是否真正拉取由 TTL 决定，
 * 因此在线客户端最迟 TTL + 间隔内拿到新目录。返回停止函数（effect 清理用）。
 */
export function startCatalogLiveRefresh(intervalMs = DEFAULT_REFRESH_INTERVAL_MS): () => void {
  const check = () => {
    void loadCatalogLiveSupplement();
  };
  const timer = setInterval(check, intervalMs);
  const hasDocument = typeof document !== "undefined";
  const onVisibilityChange = () => {
    if (document.visibilityState === "visible") check();
  };
  if (hasDocument) document.addEventListener("visibilitychange", onVisibilityChange);
  return () => {
    clearInterval(timer);
    if (hasDocument) document.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
