import { hubFetch } from "../hubFetch";
import type { McpServerConfig } from "../settings";

export type McpRegistrySource = "official" | "smithery" | "glama";

export type McpRegistryConfigInput = {
  name: string;
  targetName?: string;
  label?: string;
  description?: string;
  required: boolean;
  secret: boolean;
  target: "env" | "header" | "argument" | "url" | "config";
};

export type McpRegistryInstallDraft = {
  server: McpServerConfig;
  status: "ready" | "needs_config";
  requiredConfig: McpRegistryConfigInput[];
  warnings: string[];
  commandPreview: string;
};

export type McpRegistryCard = {
  source: McpRegistrySource;
  id: string;
  sourceId: string;
  name: string;
  displayName: string;
  description: string;
  homepageUrl?: string;
  repositoryUrl?: string;
  verified: boolean;
  remote: boolean;
  tags: string[];
  transportHints: Array<"stdio" | "http" | "sse">;
  versionLabel?: string;
  installDraft?: McpRegistryInstallDraft;
  manualDraft?: McpRegistryInstallDraft;
  installUnavailableReason?: string;
  scoreLabel?: string;
  detailUrl?: string;
};

export type McpRegistrySearchResult = {
  source: McpRegistrySource;
  items: McpRegistryCard[];
  nextCursor?: string;
  totalCount?: number;
};

export type SearchMcpRegistryParams = {
  source: McpRegistrySource;
  query?: string;
  cursor?: string;
  limit?: number;
  fetchImpl?: typeof fetch;
};

type RawRecord = Record<string, unknown>;

const OFFICIAL_REGISTRY_BASE = "https://registry.modelcontextprotocol.io/v0.1";
const SMITHERY_API_BASE = "https://api.smithery.ai";
const SMITHERY_WEB_BASE = "https://smithery.ai/servers";
const GLAMA_API_BASE = "https://glama.ai";

const DEFAULT_LIMIT = 18;

export const MCP_REGISTRY_SOURCE_OPTIONS: Array<{
  value: McpRegistrySource;
  label: string;
}> = [
  { value: "official", label: "Official" },
  { value: "smithery", label: "Smithery" },
  { value: "glama", label: "Glama" },
];

function asRecord(value: unknown): RawRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RawRecord) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asConfigString(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() ? value.trim() : undefined;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function uniqueStrings(values: Array<string | undefined>) {
  return Array.from(new Set(values.map((value) => value?.trim()).filter(Boolean) as string[]));
}

function normalizeLimit(limit: unknown) {
  const value =
    typeof limit === "number" && Number.isFinite(limit) ? Math.floor(limit) : DEFAULT_LIMIT;
  return Math.max(1, Math.min(48, value));
}

function buildUrl(base: string, path: string, params: Record<string, string | undefined>) {
  const url = new URL(path, base);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

async function fetchJson(
  url: string,
  params: { fetchImpl?: typeof fetch; headers?: Record<string, string> } = {},
): Promise<unknown> {
  // 默认经 hubFetch 出网（桌面端走本地反代+应用代理，WebUI 直连）；测试注入 fetchImpl。
  const fetchImpl = params.fetchImpl ?? hubFetch;
  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/json",
      ...params.headers,
    },
  });
  if (!response.ok) {
    // 反代/代理类失败的可行动信息在响应体里（如 502 “App proxy unavailable”），
    // 截断回显，与 clawHub 的错误回显策略一致。typeof 兜底兼容只实现 json 的测试桩。
    const detail =
      typeof response.text === "function" ? (await response.text().catch(() => "")).trim() : "";
    throw new Error(
      `MCP registry request failed with HTTP ${response.status}${
        detail ? `: ${detail.slice(0, 256)}` : ""
      }`,
    );
  }
  return response.json();
}

function slugifyServerId(input: string) {
  const parts = input.split("/").filter(Boolean);
  const leaf = input.includes("/") ? (parts[parts.length - 1] ?? input) : input;
  const normalized = leaf
    .trim()
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return normalized || "mcp-server";
}

export function createUniqueMcpServerId(baseName: string, existingIds: string[]) {
  const existing = new Set(existingIds.map((id) => id.trim()).filter(Boolean));
  const base = slugifyServerId(baseName);
  if (!existing.has(base)) return base;
  let suffix = 2;
  while (existing.has(`${base}-${suffix}`)) {
    suffix += 1;
  }
  return `${base}-${suffix}`;
}

function commandPreview(server: McpServerConfig) {
  if (server.transport === "stdio") {
    return [server.command, ...(server.args ?? [])].filter(Boolean).join(" ");
  }
  return server.url || "";
}

function makeConfigInput(
  input: RawRecord,
  target: McpRegistryConfigInput["target"],
  fallbackName?: string,
  targetName?: string,
): McpRegistryConfigInput | null {
  const name = asString(input.name) ?? fallbackName;
  if (!name) return null;
  return {
    name,
    targetName,
    label: asString(input.label) ?? asString(input.title) ?? name,
    description: asString(input.description),
    required: asBoolean(input.isRequired) || asBoolean(input.required),
    secret: asBoolean(input.isSecret) || asBoolean(input.secret),
    target,
  };
}

function inputValue(input: RawRecord) {
  return (
    asConfigString(input.value) ??
    asConfigString(input.default) ??
    asConfigString(input.example) ??
    asConfigString(asArray(input.examples)[0]) ??
    asConfigString(input.placeholder)
  );
}

function recordFromInputs(
  values: unknown[],
  target: "env" | "header",
  requiredConfig: McpRegistryConfigInput[],
) {
  const out: Record<string, string> = {};
  for (const value of values) {
    const item = asRecord(value);
    const config = makeConfigInput(item, target);
    if (!config) continue;
    const resolved = inputValue(item);
    if (resolved) {
      out[config.name] = resolved;
    } else if (config.required) {
      out[config.name] = "...";
      requiredConfig.push(config);
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function argsFromInputs(values: unknown[], requiredConfig: McpRegistryConfigInput[]) {
  const args: string[] = [];
  for (const value of values) {
    const item = asRecord(value);
    const type = asString(item.type);
    const name = asString(item.name);
    const resolved = inputValue(item);
    const hint = asString(item.valueHint) ?? name;
    const config = makeConfigInput(item, "argument", hint);

    if (type === "named" && name) {
      if (resolved) {
        args.push(`${name}=${resolved}`);
      } else if (config?.required) {
        args.push(`${name}=...`);
        requiredConfig.push(config);
      } else {
        args.push(name);
      }
      continue;
    }

    if (resolved) {
      args.push(resolved);
    } else if (config?.required) {
      args.push("...");
      requiredConfig.push(config);
    }
  }
  return args;
}

function unresolvedTemplateNames(value: string) {
  return Array.from(value.matchAll(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g)).map((match) => match[1]);
}

function pushTemplateRequirements(
  value: string | undefined,
  target: "url" | "header",
  requiredConfig: McpRegistryConfigInput[],
) {
  if (!value) return;
  for (const name of unresolvedTemplateNames(value)) {
    requiredConfig.push({
      name,
      label: name,
      required: true,
      secret: false,
      target,
    });
  }
}

function makeDraft(
  server: McpServerConfig,
  requiredConfig: McpRegistryConfigInput[],
  warnings: string[] = [],
): McpRegistryInstallDraft {
  const dedupedRequired = requiredConfig.filter(
    (item, index, array) =>
      array.findIndex(
        (candidate) => candidate.name === item.name && candidate.target === item.target,
      ) === index,
  );
  const status = dedupedRequired.length > 0 ? "needs_config" : "ready";
  return {
    server: {
      ...server,
      enabled: status === "ready",
    },
    status,
    requiredConfig: dedupedRequired,
    warnings,
    commandPreview: commandPreview(server),
  };
}

function transportType(value: unknown): "stdio" | "http" | "sse" | undefined {
  const type = asString(asRecord(value).type);
  if (type === "stdio") return "stdio";
  if (type === "streamable-http" || type === "http") return "http";
  if (type === "sse") return "sse";
  return undefined;
}

function buildRemoteDraft(
  baseName: string,
  transport: RawRecord,
  variables: RawRecord = {},
): McpRegistryInstallDraft | undefined {
  const type = transportType(transport);
  if (type !== "http" && type !== "sse") return undefined;

  const requiredConfig: McpRegistryConfigInput[] = [];
  const url = asString(transport.url) ?? "";
  pushTemplateRequirements(url, "url", requiredConfig);
  for (const [name, raw] of Object.entries(variables)) {
    const variable = asRecord(raw);
    const config = makeConfigInput(variable, "url", name);
    if (config?.required && !inputValue(variable)) {
      requiredConfig.push(config);
    }
  }

  const headers = recordFromInputs(asArray(transport.headers), "header", requiredConfig);
  return makeDraft(
    {
      id: slugifyServerId(baseName),
      enabled: true,
      transport: type,
      command: "",
      args: [],
      url,
      headers,
      timeoutMs: 60_000,
    },
    requiredConfig,
  );
}

function buildOfficialPackageDraft(
  baseName: string,
  pkg: RawRecord,
): McpRegistryInstallDraft | undefined {
  const transport = asRecord(pkg.transport);
  if (transportType(transport) !== "stdio") {
    return undefined;
  }

  const registryType = asString(pkg.registryType);
  const identifier = asString(pkg.identifier);
  const runtimeHint = asString(pkg.runtimeHint);
  let command = runtimeHint;
  if (!command && registryType === "npm") command = "npx";
  if (!command && registryType === "pypi") command = "uvx";
  if (!command || !identifier) return undefined;
  if (!["npx", "uvx"].includes(command)) return undefined;

  const requiredConfig: McpRegistryConfigInput[] = [];
  const args = [
    ...argsFromInputs(asArray(pkg.runtimeArguments), requiredConfig),
    identifier,
    ...argsFromInputs(asArray(pkg.packageArguments), requiredConfig),
  ];
  const env = recordFromInputs(asArray(pkg.environmentVariables), "env", requiredConfig);
  return makeDraft(
    {
      id: slugifyServerId(baseName),
      enabled: true,
      transport: "stdio",
      command,
      args,
      env,
      url: "",
      timeoutMs: 60_000,
    },
    requiredConfig,
  );
}

function pickOfficialDraft(server: RawRecord): McpRegistryInstallDraft | undefined {
  for (const remote of asArray(server.remotes)) {
    const remoteRecord = asRecord(remote);
    const draft = buildRemoteDraft(
      asString(server.name) ?? "mcp-server",
      remoteRecord,
      asRecord(remoteRecord.variables),
    );
    if (draft?.status === "ready") return draft;
  }

  const drafts = asArray(server.packages)
    .map((pkg) => buildOfficialPackageDraft(asString(server.name) ?? "mcp-server", asRecord(pkg)))
    .filter(Boolean) as McpRegistryInstallDraft[];
  return drafts.find((draft) => draft.status === "ready") ?? drafts[0];
}

function normalizeOfficialCard(raw: unknown): McpRegistryCard | null {
  const record = asRecord(raw);
  const server = asRecord(record.server ?? raw);
  const name = asString(server.name);
  if (!name) return null;
  const repository = asRecord(server.repository);
  const meta = asRecord(record._meta);
  const officialMeta = asRecord(meta["io.modelcontextprotocol.registry/official"]);
  const versionLabel = asString(server.version) ?? "latest";
  const installDraft = pickOfficialDraft(server);
  const transportHints = uniqueStrings([
    ...asArray(server.packages).map((pkg) => transportType(asRecord(asRecord(pkg).transport))),
    ...asArray(server.remotes).map((remote) => transportType(asRecord(remote))),
  ]) as Array<"stdio" | "http" | "sse">;

  return {
    source: "official",
    id: `official:${name}:${versionLabel}`,
    sourceId: name,
    name,
    displayName: name.includes("/") ? (name.split("/").filter(Boolean).slice(-1)[0] ?? name) : name,
    description: asString(server.description) ?? "",
    homepageUrl: asString(server.websiteUrl) ?? asString(server.homepage),
    repositoryUrl: asString(repository.url),
    verified: asString(officialMeta.status) === "active",
    remote: transportHints.some((hint) => hint === "http" || hint === "sse"),
    tags: uniqueStrings([versionLabel, asString(officialMeta.status)]),
    transportHints,
    versionLabel,
    installDraft,
    installUnavailableReason: installDraft ? undefined : "manual",
    scoreLabel: versionLabel,
    detailUrl: asString(repository.url),
  };
}

function configInputsFromJsonSchema(
  schema: unknown,
  fallbackTarget: McpRegistryConfigInput["target"] = "url",
) {
  const record = asRecord(schema);
  const properties = asRecord(record.properties);
  const required = new Set(asArray(record.required).map(asString).filter(Boolean) as string[]);
  return Object.entries(properties).map(([name, raw]) => {
    const property = asRecord(raw);
    const from = asRecord(property["x-from"]);
    const headerName = asString(from.header);
    const queryName = asString(from.query);
    const envName = asString(from.env);
    const argumentName = asString(from.argument) ?? asString(from.arg);
    const target: McpRegistryConfigInput["target"] = headerName
      ? "header"
      : envName
        ? "env"
        : argumentName
          ? "argument"
          : fallbackTarget;
    const targetName = headerName ?? envName ?? argumentName ?? queryName ?? name;
    return {
      name,
      targetName,
      label: asString(property.title) ?? name,
      description: asString(property.description),
      required: required.has(name),
      secret: /token|secret|key|password/i.test(name),
      target,
    };
  });
}

function envRecordFromJsonSchema(schema: unknown) {
  const record = asRecord(schema);
  const properties = asRecord(record.properties);
  const required = new Set(asArray(record.required).map(asString).filter(Boolean) as string[]);
  const objectExamples = [
    asRecord(record.value),
    asRecord(record.default),
    asRecord(record.example),
    ...asArray(record.examples).map(asRecord),
  ];
  const out: Record<string, string> = {};

  for (const [name, raw] of Object.entries(properties)) {
    const property = asRecord(raw);
    const exampleValue = objectExamples
      .map((example) => asConfigString(example[name]))
      .find(Boolean);
    const resolved = exampleValue ?? inputValue(property);
    if (resolved) {
      out[name] = resolved;
    } else if (required.has(name)) {
      out[name] = "...";
    }
  }

  if (Object.keys(properties).length === 0) {
    for (const [name, raw] of Object.entries(record)) {
      if (
        ["type", "required", "properties", "value", "default", "example", "examples"].includes(name)
      ) {
        continue;
      }
      const resolved = asConfigString(raw);
      if (resolved) out[name] = resolved;
    }
  }

  return Object.keys(out).length ? out : undefined;
}

function buildManualStdioDraft(
  baseName: string,
  packageName: string,
  requiredConfig: McpRegistryConfigInput[] = [],
  env?: Record<string, string>,
): McpRegistryInstallDraft | undefined {
  const normalizedPackage = packageName.trim();
  if (!normalizedPackage) return undefined;
  return makeDraft(
    {
      id: slugifyServerId(baseName),
      enabled: false,
      transport: "stdio",
      command: "npx",
      args: ["-y", normalizedPackage],
      env,
      url: "",
      timeoutMs: 60_000,
    },
    requiredConfig,
  );
}

function normalizeSmitherySearchCard(raw: unknown): McpRegistryCard | null {
  const item = asRecord(raw);
  const qualifiedName = asString(item.qualifiedName) ?? asString(item.name) ?? asString(item.id);
  if (!qualifiedName) return null;
  const displayName = asString(item.displayName) ?? qualifiedName;
  const homepageUrl = asString(item.homepage) ?? `${SMITHERY_WEB_BASE}/${qualifiedName}`;
  const useCount = asNumber(item.useCount);

  return {
    source: "smithery",
    id: `smithery:${qualifiedName}`,
    sourceId: qualifiedName,
    name: qualifiedName,
    displayName,
    description: asString(item.description) ?? "",
    homepageUrl,
    verified: asBoolean(item.verified),
    remote: asBoolean(item.remote) || asBoolean(item.isDeployed),
    tags: uniqueStrings([
      asBoolean(item.remote) ? "remote" : undefined,
      asBoolean(item.bySmithery) ? "smithery" : undefined,
    ]),
    transportHints: asBoolean(item.remote) || asBoolean(item.isDeployed) ? ["http"] : [],
    installUnavailableReason:
      asBoolean(item.remote) || asBoolean(item.isDeployed) ? undefined : "manual",
    scoreLabel: useCount !== undefined ? `${useCount}` : undefined,
    detailUrl: homepageUrl,
  };
}

function normalizeSmitheryDetail(card: McpRegistryCard, raw: unknown): McpRegistryCard {
  const item = asRecord(raw);
  const connections = asArray(item.connections);
  const httpConnection = connections
    .map(asRecord)
    .find(
      (connection) => asString(connection.type) === "http" && asString(connection.deploymentUrl),
    );
  const stdioConnection = connections
    .map(asRecord)
    .find((connection) => asString(connection.type) === "stdio");
  const deploymentUrl = asString(item.deploymentUrl) ?? asString(httpConnection?.deploymentUrl);
  const requiredConfig = configInputsFromJsonSchema(httpConnection?.configSchema);
  const httpDraft = deploymentUrl
    ? makeDraft(
        {
          id: slugifyServerId(card.name),
          enabled: true,
          transport: "http",
          command: "",
          args: [],
          url: deploymentUrl,
          timeoutMs: 60_000,
        },
        requiredConfig,
      )
    : undefined;
  const stdioDraft = stdioConnection
    ? makeDraft(
        {
          id: slugifyServerId(card.name),
          enabled: true,
          transport: "stdio",
          command: "npx",
          args: ["-y", "@smithery/cli@latest", "run", card.sourceId],
          url: "",
          timeoutMs: 60_000,
        },
        configInputsFromJsonSchema(stdioConnection.configSchema, "config"),
      )
    : undefined;
  const installDraft = httpDraft ?? stdioDraft;

  return {
    ...card,
    displayName: asString(item.displayName) ?? card.displayName,
    description: asString(item.description) ?? card.description,
    homepageUrl: asString(item.homepage) ?? card.homepageUrl,
    installDraft,
    installUnavailableReason: installDraft ? undefined : "manual",
    transportHints: installDraft ? [installDraft.server.transport] : card.transportHints,
    remote: installDraft?.server.transport === "stdio" ? false : card.remote,
  };
}

function normalizeGlamaCard(raw: unknown): McpRegistryCard | null {
  const item = asRecord(raw);
  const id = asString(item.id) ?? asString(item.slug) ?? asString(item.name);
  const name = asString(item.name) ?? asString(item.slug) ?? id;
  if (!id || !name) return null;
  const repository = asRecord(item.repository);
  const envInputs = configInputsFromJsonSchema(item.environmentVariablesJsonSchema).map(
    (input) => ({
      ...input,
      target: "env" as const,
    }),
  );
  const env = envRecordFromJsonSchema(item.environmentVariablesJsonSchema);
  const packageName =
    asString(item.packageName) ?? asString(item.npmPackage) ?? asString(item.slug) ?? name;
  const manualDraft = buildManualStdioDraft(name, packageName, envInputs, env);
  const attributes = asArray(item.attributes).map(asString).filter(Boolean) as string[];
  return {
    source: "glama",
    id: `glama:${id}`,
    sourceId: id,
    name,
    displayName: name,
    description: asString(item.description) ?? "",
    homepageUrl: asString(item.url),
    repositoryUrl: asString(repository.url),
    verified: false,
    remote: !attributes.includes("hosting:local-only"),
    tags: uniqueStrings([
      asString(item.namespace),
      asString(asRecord(item.spdxLicense).name),
      ...attributes.slice(0, 3),
    ]),
    transportHints: manualDraft ? ["stdio"] : [],
    installUnavailableReason: envInputs.length > 0 ? "needs-manual-command" : "manual",
    manualDraft,
    detailUrl: asString(item.url) ?? asString(repository.url),
  };
}

async function searchOfficial(params: SearchMcpRegistryParams): Promise<McpRegistrySearchResult> {
  const url = buildUrl(OFFICIAL_REGISTRY_BASE, "/v0.1/servers", {
    limit: String(normalizeLimit(params.limit)),
    search: params.query?.trim() || undefined,
    cursor: params.cursor,
  });
  const json = asRecord(await fetchJson(url, { fetchImpl: params.fetchImpl }));
  const metadata = asRecord(json.metadata);
  return {
    source: "official",
    items: asArray(json.servers).map(normalizeOfficialCard).filter(Boolean) as McpRegistryCard[],
    nextCursor: asString(metadata.nextCursor),
    totalCount: asNumber(metadata.count),
  };
}

async function searchSmithery(params: SearchMcpRegistryParams): Promise<McpRegistrySearchResult> {
  const pageSize = normalizeLimit(params.limit);
  const page = params.cursor ?? "1";
  const url = buildUrl(SMITHERY_API_BASE, "/servers", {
    q: params.query?.trim() || undefined,
    pageSize: String(pageSize),
    page,
  });
  const json = asRecord(await fetchJson(url, { fetchImpl: params.fetchImpl }));
  const pagination = asRecord(json.pagination);
  const currentPage = asNumber(pagination.currentPage) ?? Number(page);
  const totalPages = asNumber(pagination.totalPages);
  const nextCursor =
    totalPages !== undefined && currentPage < totalPages ? String(currentPage + 1) : undefined;
  return {
    source: "smithery",
    items: asArray(json.servers)
      .map(normalizeSmitherySearchCard)
      .filter(Boolean) as McpRegistryCard[],
    nextCursor,
    totalCount: asNumber(pagination.totalCount),
  };
}

async function searchGlama(params: SearchMcpRegistryParams): Promise<McpRegistrySearchResult> {
  const url = buildUrl(GLAMA_API_BASE, "/api/mcp/v1/servers", {
    first: String(normalizeLimit(params.limit)),
    query: params.query?.trim() || undefined,
    after: params.cursor,
  });
  const json = asRecord(await fetchJson(url, { fetchImpl: params.fetchImpl }));
  const pageInfo = asRecord(json.pageInfo);
  return {
    source: "glama",
    items: asArray(json.servers).map(normalizeGlamaCard).filter(Boolean) as McpRegistryCard[],
    nextCursor: asBoolean(pageInfo.hasNextPage) ? asString(pageInfo.endCursor) : undefined,
  };
}

export async function searchMcpRegistry(
  params: SearchMcpRegistryParams,
): Promise<McpRegistrySearchResult> {
  switch (params.source) {
    case "official":
      return searchOfficial(params);
    case "smithery":
      return searchSmithery(params);
    case "glama":
      return searchGlama(params);
    default:
      throw new Error("Unsupported MCP registry source");
  }
}

function encodeSmitheryPath(name: string) {
  return name.split("/").map(encodeURIComponent).join("/");
}

export async function resolveMcpRegistryInstallDraft(
  card: McpRegistryCard,
  params: Pick<SearchMcpRegistryParams, "fetchImpl"> = {},
): Promise<McpRegistryCard> {
  if (card.installDraft || card.source !== "smithery") {
    return card;
  }
  const detail = await fetchJson(
    `${SMITHERY_API_BASE}/servers/${encodeSmitheryPath(card.sourceId)}`,
    { fetchImpl: params.fetchImpl },
  );
  return normalizeSmitheryDetail(card, detail);
}

export function withUniqueMcpServerId(
  draft: McpRegistryInstallDraft,
  existingServers: McpServerConfig[],
): McpRegistryInstallDraft {
  const id = createUniqueMcpServerId(
    draft.server.id || draft.server.command || draft.server.url,
    existingServers.map((server) => server.id),
  );
  return {
    ...draft,
    server: {
      ...draft.server,
      id,
    },
    commandPreview: commandPreview({ ...draft.server, id }),
  };
}

export function mcpRegistryConfigInputKey(input: McpRegistryConfigInput) {
  return `${input.target}:${input.targetName ?? input.name}`;
}

function replaceUrlConfigValue(url: string, input: McpRegistryConfigInput, value: string) {
  const targetName = input.targetName ?? input.name;
  const encodedValue = encodeURIComponent(value);
  let nextUrl = url;
  const templateNames = uniqueStrings([targetName, input.name]);
  for (const name of templateNames) {
    nextUrl = nextUrl.split(`{${name}}`).join(encodedValue);
  }
  if (nextUrl !== url) {
    return nextUrl;
  }

  try {
    const parsed = new URL(nextUrl);
    parsed.searchParams.set(targetName, value);
    return parsed.toString();
  } catch {
    const separator = nextUrl.includes("?") ? "&" : "?";
    return `${nextUrl}${separator}${encodeURIComponent(targetName)}=${encodedValue}`;
  }
}

function replaceArgumentConfigValue(args: string[], input: McpRegistryConfigInput, value: string) {
  const names = uniqueStrings([input.targetName, input.name]);
  const placeholderIndex = args.findIndex(
    (arg) =>
      arg === "..." || arg.includes("...") || names.some((name) => arg.includes(`{${name}}`)),
  );
  if (placeholderIndex < 0) {
    return [...args, value];
  }

  const current = args[placeholderIndex];
  let next = current.replace("...", value);
  for (const name of names) {
    next = next.split(`{${name}}`).join(value);
  }
  return args.map((arg, index) => (index === placeholderIndex ? next : arg));
}

function readConfigArg(args: string[]) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--config") {
      return asRecordFromJson(args[index + 1]);
    }
    if (arg.startsWith("--config=")) {
      return asRecordFromJson(arg.slice("--config=".length));
    }
  }
  return {};
}

function asRecordFromJson(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function upsertConfigArg(args: string[], config: Record<string, unknown>) {
  const serialized = JSON.stringify(config);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--config") {
      const next = [...args];
      if (index + 1 < next.length) {
        next[index + 1] = serialized;
      } else {
        next.push(serialized);
      }
      return next;
    }
    if (arg.startsWith("--config=")) {
      const next = [...args];
      next[index] = `--config=${serialized}`;
      return next;
    }
  }
  return [...args, "--config", serialized];
}

function replaceConfigArgValue(args: string[], input: McpRegistryConfigInput, value: string) {
  const targetName = input.targetName ?? input.name;
  return upsertConfigArg(args, {
    ...readConfigArg(args),
    [targetName]: value,
  });
}

export function applyMcpRegistryInstallConfig(
  draft: McpRegistryInstallDraft,
  values: Record<string, string>,
): McpRegistryInstallDraft {
  let server: McpServerConfig = {
    ...draft.server,
    args: [...(draft.server.args ?? [])],
    env: draft.server.env ? { ...draft.server.env } : undefined,
    headers: draft.server.headers ? { ...draft.server.headers } : undefined,
  };

  for (const input of draft.requiredConfig) {
    const key = mcpRegistryConfigInputKey(input);
    const value = (values[key] ?? values[input.name] ?? "").trim();
    if (!value) {
      continue;
    }
    const targetName = input.targetName ?? input.name;

    if (input.target === "env") {
      server = {
        ...server,
        env: {
          ...(server.env ?? {}),
          [targetName]: value,
        },
      };
      continue;
    }

    if (input.target === "header") {
      server = {
        ...server,
        headers: {
          ...(server.headers ?? {}),
          [targetName]: value,
        },
      };
      continue;
    }

    if (input.target === "argument") {
      server = {
        ...server,
        args: replaceArgumentConfigValue(server.args ?? [], input, value),
      };
      continue;
    }

    if (input.target === "config") {
      server = {
        ...server,
        args: replaceConfigArgValue(server.args ?? [], input, value),
      };
      continue;
    }

    server = {
      ...server,
      url: replaceUrlConfigValue(server.url ?? "", input, value),
    };
  }

  return {
    ...draft,
    server: {
      ...server,
      enabled: true,
    },
    status: "ready",
    requiredConfig: [],
    commandPreview: commandPreview(server),
  };
}
