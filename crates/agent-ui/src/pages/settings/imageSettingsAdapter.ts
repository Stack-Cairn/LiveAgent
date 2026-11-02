import type {
  ImageConnection,
  ImageSettings,
  ImageSettingsUpdate,
  ImageStudioClient,
  ImageTarget,
  Operation,
  ParameterSpec,
  WorkflowMapping,
} from "../../lib/imaging/types";

export const imageProtocols = [
  { id: "openai-images", label: "OpenAI Images" },
  { id: "rolldek-images", label: "RollDek Images" },
  { id: "google-generate-content-image", label: "Google generateContent" },
  { id: "volcengine-ark-image", label: "火山方舟 Images" },
  { id: "jimeng-image", label: "即梦 Visual OpenAPI" },
  { id: "runninghub-workflow", label: "RunningHub 工作流" },
  { id: "runninghub-model", label: "RunningHub 模型 API" },
] as const;
export const imageSecretPurposeLabels = {
  apiKey: "API Key",
  accessKey: "Access Key",
  secretKey: "Secret Key",
  securityToken: "Security Token（可选）",
} as const;
export type ImageSecretPurpose = keyof typeof imageSecretPurposeLabels;
export function canonicalImageSecretPurpose(purpose: string): ImageSecretPurpose | undefined {
  const aliases: Record<string, ImageSecretPurpose> = {
    api_key: "apiKey",
    access_key: "accessKey",
    secret_key: "secretKey",
    security_token: "securityToken",
  };
  if (Object.hasOwn(imageSecretPurposeLabels, purpose)) return purpose as ImageSecretPurpose;
  return Object.hasOwn(aliases, purpose) ? aliases[purpose] : undefined;
}
function canonicalSecretRefs(refs: Record<string, string> = {}): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [purpose, ref] of Object.entries(refs)) {
    const canonical = canonicalImageSecretPurpose(purpose) ?? purpose;
    result[canonical] = refs[canonical] ?? ref;
  }
  return result;
}
export function imageSecretPurposes(
  settings: ImageSettings,
  connectionId: string,
): ImageSecretPurpose[] {
  const connection = settings.connections.find((item) => item.id === connectionId);
  const protocols = settings.targets.filter((item) => item.connectionId === connectionId);
  const purposes = new Set<ImageSecretPurpose>();
  for (const target of protocols) {
    if (target.adapter === "jimeng-image") {
      purposes.add("accessKey").add("secretKey").add("securityToken");
    } else if (imageProtocols.some((protocol) => protocol.id === target.adapter)) {
      purposes.add("apiKey");
    }
  }
  if (!purposes.size) {
    if (
      connection?.binding.kind === "independent" &&
      connection.binding.authKind === "signed_request"
    )
      purposes.add("accessKey").add("secretKey").add("securityToken");
    else purposes.add("apiKey");
  }
  return [...purposes];
}
export const imageOperationLabels: Record<Operation, string> = {
  generate: "文字生成",
  reference: "参考生成",
  edit: "编辑",
  mask: "遮罩编辑",
};
const keyPattern = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
const refPattern = /^is_[a-f0-9]{32}$/;
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export function newImageConnection(id: string): ImageConnection {
  return {
    id,
    name: "新图像连接",
    vendor: "openai",
    enabled: true,
    credentialConfigured: false,
    maxConcurrent: 2,
    binding: {
      kind: "independent",
      baseUrl: "https://api.openai.com/v1",
      authKind: "bearer",
      secretRefs: {},
    },
  };
}
export function newImageTarget(id: string, connectionId: string): ImageTarget {
  return {
    id,
    name: "新图像目标",
    connectionId,
    adapter: "openai-images",
    adapterVersion: "1",
    kind: "model",
    remoteId: "",
    revision: 0,
    enabled: false,
    capabilities: {
      operations: ["generate"],
      supportsCancel: false,
      supportsReconcile: false,
      supportsContinuation: false,
      supportsPreview: false,
      maxInputs: 0,
      maxCount: 1,
      outputFormats: ["png"],
    },
    parameters: [],
  };
}
export function settingsUpdate(settings: ImageSettings): ImageSettingsUpdate {
  return {
    expectedRevision: settings.revision,
    connections: settings.connections.map((connection) =>
      connection.binding.kind === "independent"
        ? {
            ...connection,
            binding: {
              ...connection.binding,
              secretRefs: canonicalSecretRefs(connection.binding.secretRefs),
            },
          }
        : connection,
    ),
    targets: settings.targets,
  };
}
export function imageSettingsDirty(
  saved: ImageSettings | null,
  draft: ImageSettings | null,
): boolean {
  return !same(saved, draft);
}
/** K-brain 尚未完成这些适配器，拒绝保存启用状态的目标（config_validate.go）。 */
export const unfinishedImageAdapters: readonly string[] = [
  "google-interactions-image",
  "runninghub-workflow",
  "jimeng-image",
];
export function patchImageTarget(target: ImageTarget, patch: Partial<ImageTarget>): ImageTarget {
  const next = { ...target, ...patch };
  return unfinishedImageAdapters.includes(next.adapter) ? { ...next, enabled: false } : next;
}
export function patchImageConnection(
  settings: ImageSettings,
  id: string,
  patch: Partial<ImageConnection>,
): ImageSettings {
  const previous = settings.connections.find((c) => c.id === id);
  if (!previous) return settings;
  const next = { ...previous, ...patch };
  // The backend rejects an enabled target on a disabled connection.
  const invalidate = !next.enabled;
  return {
    ...settings,
    connections: settings.connections.map((c) => (c.id === id ? next : c)),
    targets: settings.targets.map((t) =>
      invalidate && t.connectionId === id ? { ...t, enabled: false } : t,
    ),
  };
}
export function connectionDependents(settings: ImageSettings, id: string): ImageTarget[] {
  return settings.targets.filter((t) => t.connectionId === id);
}
export function removeImageConnection(settings: ImageSettings, id: string): ImageSettings {
  if (connectionDependents(settings, id).length) throw new Error("请先移除或改用其他连接的目标。");
  return { ...settings, connections: settings.connections.filter((c) => c.id !== id) };
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function keysOnly(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
function scalarMatches(value: unknown, p: ParameterSpec): boolean {
  if (p.type === "string" || p.type === "boolean") return typeof value === p.type;
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    (p.type !== "integer" || Number.isSafeInteger(value)) &&
    (p.minimum === undefined || value >= p.minimum) &&
    (p.maximum === undefined || value <= p.maximum)
  );
}
export function parseImageParameters(raw: string): ParameterSpec[] {
  const invalid = () => new Error("参数定义无效：检查唯一 key、类型、必填、枚举、范围和默认值。");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw invalid();
  }
  if (!Array.isArray(value)) throw invalid();
  const seen = new Set<string>();
  for (const entry of value) {
    if (
      !object(entry) ||
      !keysOnly(entry, [
        "key",
        "label",
        "type",
        "required",
        "enum",
        "minimum",
        "maximum",
        "default",
        "unit",
      ]) ||
      typeof entry.key !== "string" ||
      !keyPattern.test(entry.key) ||
      seen.has(entry.key) ||
      typeof entry.label !== "string" ||
      !entry.label.trim() ||
      !["string", "number", "integer", "boolean"].includes(String(entry.type)) ||
      typeof entry.required !== "boolean" ||
      (entry.unit !== undefined && typeof entry.unit !== "string")
    )
      throw invalid();
    seen.add(entry.key);
    const p = entry as unknown as ParameterSpec;
    for (const bound of [p.minimum, p.maximum])
      if (
        bound !== undefined &&
        (!["number", "integer"].includes(p.type) ||
          typeof bound !== "number" ||
          !Number.isFinite(bound) ||
          (p.type === "integer" && !Number.isSafeInteger(bound)))
      )
        throw invalid();
    if (p.minimum !== undefined && p.maximum !== undefined && p.minimum > p.maximum)
      throw invalid();
    if (
      p.enum !== undefined &&
      (!Array.isArray(p.enum) ||
        !p.enum.length ||
        p.enum.some((v) => !scalarMatches(v, p)) ||
        new Set(p.enum.map((v) => JSON.stringify(v))).size !== p.enum.length)
    )
      throw invalid();
    if (
      p.default !== undefined &&
      (!scalarMatches(p.default, p) || (p.enum !== undefined && !p.enum.includes(p.default)))
    )
      throw invalid();
  }
  return value as ParameterSpec[];
}
export function parseWorkflowMapping(raw: string): WorkflowMapping {
  const invalid = () =>
    new Error("工作流映射无效：需要正整数版本、输入字段和至少一个输出节点；节点和字段不能重复。");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw invalid();
  }
  if (
    !object(value) ||
    !keysOnly(value, ["revision", "inputs", "outputs"]) ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 1 ||
    !Array.isArray(value.inputs) ||
    !Array.isArray(value.outputs) ||
    !value.outputs.length
  )
    throw invalid();
  const parameters = new Set<string>();
  const inputSlots = new Set<string>();
  const outputSlots = new Set<string>();
  for (const i of value.inputs) {
    if (
      !object(i) ||
      !keysOnly(i, ["parameterKey", "nodeId", "inputName"]) ||
      typeof i.parameterKey !== "string" ||
      !keyPattern.test(i.parameterKey) ||
      typeof i.nodeId !== "string" ||
      !i.nodeId.trim() ||
      typeof i.inputName !== "string" ||
      !i.inputName.trim()
    )
      throw invalid();
    const slot = JSON.stringify([i.nodeId, i.inputName]);
    if (parameters.has(i.parameterKey) || inputSlots.has(slot)) throw invalid();
    parameters.add(i.parameterKey);
    inputSlots.add(slot);
  }
  for (const o of value.outputs) {
    if (
      !object(o) ||
      !keysOnly(o, ["nodeId", "outputName"]) ||
      typeof o.nodeId !== "string" ||
      !o.nodeId.trim() ||
      typeof o.outputName !== "string" ||
      !o.outputName.trim()
    )
      throw invalid();
    const slot = JSON.stringify([o.nodeId, o.outputName]);
    if (outputSlots.has(slot)) throw invalid();
    outputSlots.add(slot);
  }
  return value as unknown as WorkflowMapping;
}
export function validateImageSettingsDraft(settings: ImageSettings): string[] {
  const errors: string[] = [];
  const connections = new Set<string>();
  for (const c of settings.connections) {
    if (!/^ic_[A-Za-z0-9_-]+$/.test(c.id) || c.id.length > 256 || connections.has(c.id))
      errors.push("连接标识无效或重复。");
    connections.add(c.id);
    if (!c.name.trim() || !c.vendor.trim()) errors.push("请填写连接名称和供应商。");
    if (!Number.isInteger(c.maxConcurrent) || c.maxConcurrent < 1 || c.maxConcurrent > 16)
      errors.push("连接并发必须为 1–16。");
    if (c.binding.kind === "provider_ref") {
      if (!c.binding.providerId.trim()) errors.push("请填写已有供应商 ID。");
    } else {
      try {
        const url = new URL(c.binding.baseUrl);
        if (
          !["https:", "http:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        )
          errors.push("连接地址不能包含凭据、查询参数或片段。");
      } catch {
        errors.push("请填写有效连接地址。");
      }
      if (!["bearer", "api_key_header", "signed_request"].includes(c.binding.authKind))
        errors.push("请选择有效认证方式。");
      if (
        Object.entries(c.binding.secretRefs ?? {}).some(
          ([purpose, ref]) => !keyPattern.test(purpose) || !refPattern.test(ref),
        )
      )
        errors.push("凭据必须使用后端返回的引用。");
    }
  }
  const targets = new Set<string>();
  for (const t of settings.targets) {
    if (!/^it_[A-Za-z0-9_-]+$/.test(t.id) || t.id.length > 256 || targets.has(t.id))
      errors.push("目标标识无效或重复。");
    targets.add(t.id);
    if (!connections.has(t.connectionId)) errors.push("目标缺少连接。");
    // Mirrors K-brain config_validate.go: enabled targets need an enabled connection.
    if (t.enabled && settings.connections.some((c) => c.id === t.connectionId && !c.enabled))
      errors.push("已启用的目标不能使用已停用的连接，请先启用连接或停用目标。");
    if (!t.name.trim() || !t.remoteId.trim() || !t.adapter.trim() || !t.adapterVersion.trim())
      errors.push("请填写目标名称、协议版本及模型或工作流标识。");
    const c = t.capabilities;
    if (
      !c.operations.length ||
      new Set(c.operations).size !== c.operations.length ||
      c.operations.some((op) => !Object.hasOwn(imageOperationLabels, op))
    )
      errors.push("至少声明一种有效且不重复的操作。");
    if (
      !Number.isInteger(c.maxInputs) ||
      c.maxInputs < 0 ||
      c.maxInputs > 16 ||
      !Number.isInteger(c.maxCount) ||
      c.maxCount < 1 ||
      c.maxCount > 16
    )
      errors.push("输入图片数量须为 0–16，输出数量须为 1–16。");
    if (
      (c.operations.includes("mask") && c.maxInputs < 2) ||
      (c.operations.some((op) => op === "edit" || op === "reference") && c.maxInputs < 1)
    )
      errors.push("参考或编辑需要至少一张输入图；遮罩需要至少两张。");
    if (
      !c.outputFormats.length ||
      c.outputFormats.some((f) => !["png", "jpeg", "webp"].includes(f)) ||
      new Set(c.outputFormats).size !== c.outputFormats.length
    )
      errors.push("请选择有效且不重复的输出格式。");
    try {
      parseImageParameters(JSON.stringify(t.parameters));
    } catch {
      errors.push("参数 schema 无效，请检查类型、枚举和默认值。");
    }
    if (t.kind === "workflow") {
      try {
        const mapping = parseWorkflowMapping(JSON.stringify(t.workflowMapping));
        if (
          mapping.inputs.length !== t.parameters.length ||
          mapping.inputs.some((i) => !t.parameters.some((p) => p.key === i.parameterKey))
        )
          errors.push("工作流必须为每个已声明参数提供唯一输入映射。");
      } catch {
        errors.push("工作流需要有效版本和节点映射。");
      }
    } else if (t.workflowMapping) errors.push("模型目标不能包含工作流映射。");
    if (t.adapter === "runninghub-workflow" && t.kind !== "workflow")
      errors.push("RunningHub 协议需要工作流目标。");
  }
  return [...new Set(errors)];
}

export function imageSettingsErrorCode(error: unknown): string {
  return object(error) && typeof error.code === "string" ? error.code : "";
}
/** Never reflect arbitrary transport error messages, request IDs or diagnostics. */
export function imageSettingsError(error: unknown): string {
  switch (imageSettingsErrorCode(error)) {
    case "IMAGE_REVISION_CONFLICT":
      return "设置已被其他页面更新。草稿已保留，请读取最新版本并处理冲突。";
    case "IMAGE_CONNECTION_IN_USE":
      return "连接或目标仍被任务引用。请等待任务结束，并先移除依赖目标。";
    case "IMAGE_AUTH_REQUIRED":
    case "IMAGE_FORBIDDEN":
      return "当前身份无法修改图像设置，请检查登录状态和权限。";
    case "IMAGE_INVALID_INPUT":
      return "设置未被接受，请检查连接、模型标识、参数和工作流映射。";
    case "IMAGE_NOT_FOUND":
      return "连接或目标已不存在，请读取最新设置。";
    case "IMAGE_UNSUPPORTED_OPERATION":
      return "当前后端不支持此操作，请检查后端版本。";
    default:
      return "操作未能确认完成。草稿已保留，请检查后端连接后读取最新设置。";
  }
}

/** Three-way, per-entity merge: remote additions/edits survive unless that entity
 * was also edited locally. Conflicting entities require an explicit UI choice. */
export function mergeImageSettings(
  base: ImageSettings,
  draft: ImageSettings,
  remote: ImageSettings,
  prefer: "local" | "remote" = "local",
): { draft: ImageSettings; conflicts: string[] } {
  const conflicts: string[] = [];
  function merge<T extends { id: string }>(before: T[], local: T[], latest: T[]): T[] {
    const ids = new Set([...latest, ...local, ...before].map((item) => item.id));
    const result: T[] = [];
    for (const id of ids) {
      const b = before.find((item) => item.id === id),
        l = local.find((item) => item.id === id),
        r = latest.find((item) => item.id === id);
      const conflict = !same(b, l) && !same(b, r) && !same(l, r);
      if (conflict) conflicts.push(id);
      const value = conflict ? (prefer === "local" ? l : r) : same(b, l) ? r : l;
      if (value) result.push(value);
    }
    return result;
  }
  const connections = merge(base.connections, draft.connections, remote.connections);
  const targets = merge(base.targets, draft.targets, remote.targets).map((target) => {
    const remoteTarget = remote.targets.find((t) => t.id === target.id);
    const connection = connections.find((c) => c.id === target.connectionId);
    const remoteConnection = remote.connections.find((c) => c.id === target.connectionId);
    // A merge never grants verification to an execution definition.
    return !same(target, remoteTarget) || !same(connection?.binding, remoteConnection?.binding)
      ? { ...target, enabled: false }
      : target;
  });
  return { draft: { revision: remote.revision, connections, targets }, conflicts };
}

/** Only accepts a saved snapshot. Caller must clear its password input before
 * awaiting this function, and retain onPrepared's public draft if binding fails.
 * No compensating revoke: a purpose can rotate an already-referenced secret. */
export async function writeAndBindImageSecret(
  client: Pick<ImageStudioClient, "writeSecret" | "saveSettings">,
  saved: ImageSettings,
  connectionId: string,
  purpose: string,
  value: string,
  isCurrent: () => boolean,
  onPrepared: (draft: ImageSettings) => void,
): Promise<ImageSettings | null> {
  const connection = saved.connections.find((c) => c.id === connectionId);
  const canonicalPurpose = canonicalImageSecretPurpose(purpose);
  if (
    !connection ||
    connection.binding.kind !== "independent" ||
    !canonicalPurpose ||
    !value ||
    !isCurrent()
  )
    return null;
  const input = { connectionId, purpose: canonicalPurpose, value };
  value = "";
  let result: Awaited<ReturnType<ImageStudioClient["writeSecret"]>>;
  try {
    result = await client.writeSecret(input);
  } finally {
    input.value = "";
  }
  if (!isCurrent()) return null;
  if (!result.configured || !refPattern.test(result.ref)) throw new Error("凭据未能确认写入。");
  const next = patchImageConnection(saved, connectionId, {
    binding: {
      ...connection.binding,
      secretRefs: {
        ...canonicalSecretRefs(connection.binding.secretRefs),
        [canonicalPurpose]: result.ref,
      },
    },
  });
  onPrepared(next);
  if (!isCurrent()) return null;
  const response = await client.saveSettings(settingsUpdate(next));
  return isCurrent() ? response : null;
}
