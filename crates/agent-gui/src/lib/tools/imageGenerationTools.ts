// 内置生图工具 generate_image（设计文档 §6.7）。
//
// 生图不走四类聊天接口——pi-ai 的 AssistantMessage.content 只有 text / thinking /
// toolCall，聊天流拿不到图片输出。所以这里自己按 imageGeneration.ts 拼请求，交给
// 桌面端 provider_generate_image（WebUI 走网关桥 gateway_provider_generate_image）
// 发出去，再把结果用同一套工作区写文件能力（fs_write_text + encoding=base64）落盘。
//
// 模型选择优先级：工具参数 model（"<providerId>:<modelId>"）> 设置里的默认生图
// 模型 > 第一个启用供应商里第一个启用的 image 类型模型。

import type { Tool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { invoke } from "@liveagent/app/shims/tauriCore";
import {
  isImageGenerationModel,
  listImageGenerationModels,
} from "@liveagent/ui/lib/models/modelType";
import {
  buildImageGenerationRequest,
  clampImageCount,
  type GeneratedImage,
  IMAGE_GENERATION_MAX_COUNT,
  type ImageGenerationRoute,
  parseImageGenerationResponse,
  resolveImageGenerationRoute,
} from "@liveagent/ui/lib/providers/imageGeneration";
import { isGatewayWebuiRuntime } from "@liveagent/ui/lib/runtimeEnv";
import { getProviderCredentials } from "@liveagent/ui/lib/settings";
import type { AppSettings, CustomProvider } from "@liveagent/ui/lib/settings/types";
import { invokeFs } from "@liveagent/ui/lib/tools/fsBackend";
import { Type } from "typebox";
import { type BuiltinToolBundle, createBuiltinMetadataMap } from "./builtinTypes";
import { createToolRunId, invokeWithAbort, requestRuntimeCancel } from "./invokeWithAbort";
import { ToolPathResolver } from "./pathUtils";

export const GENERATE_IMAGE_TOOL_NAME = "generate_image";

/** 缺省落盘目录（工作区相对）。 */
const DEFAULT_SAVE_DIR = "generated-images";
/** 生图请求的超时；与 Rust 侧缺省一致。 */
const GENERATE_TIMEOUT_MS = 120_000;

const GENERATE_IMAGE_PARAMETERS = Type.Object(
  {
    prompt: Type.String({
      minLength: 1,
      description:
        "What the image should show. Be specific about subject, style, composition and lighting; the image model has no access to the conversation, so the prompt must stand alone.",
    }),
    count: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: IMAGE_GENERATION_MAX_COUNT,
        description: `How many images to generate. Defaults to 1, capped at ${IMAGE_GENERATION_MAX_COUNT}. Gemini image models always return a single image regardless of this value.`,
      }),
    ),
    size: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Output size such as 1024x1024 (square), 1536x1024 (landscape) or 1024x1536 (portrait). Only honoured by OpenAI Images models; Gemini image models ignore it.",
      }),
    ),
    quality: Type.Optional(
      Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")], {
        description:
          "Rendering quality. Only honoured by OpenAI Images models; higher quality costs more and takes longer.",
      }),
    ),
    model: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          'Override the image model, written as "<providerId>:<modelId>" (for example "p-openai:gpt-image-1"). Defaults to the image model configured in Settings, or the first enabled image model.',
      }),
    ),
    save_to: Type.Optional(
      Type.String({
        minLength: 1,
        description: `Workspace-relative directory to save the images into. Defaults to "${DEFAULT_SAVE_DIR}/". Must stay inside the workspace.`,
      }),
    ),
  },
  { additionalProperties: false },
);

const toolGenerateImage: Tool = {
  name: GENERATE_IMAGE_TOOL_NAME,
  description: [
    "Generate images from a text prompt using the configured image-generation model and save them into the workspace.",
    "Use it when the user asks for a picture, illustration, icon, logo, mockup, diagram rendering or any other new image.",
    "It does not edit or analyse existing images — use Read/Image for that.",
    "Returns the generated images inline plus the paths they were saved to.",
  ].join(" "),
  parameters: GENERATE_IMAGE_PARAMETERS,
};

export type ImageGenerationToolSettings = Pick<AppSettings, "customProviders"> &
  Partial<Pick<AppSettings, "imageGeneration">>;

type SelectedImageModel = {
  provider: CustomProvider;
  modelId: string;
  /** 选中来源，写进 details 便于排查"为什么用了这个模型"。 */
  source: "argument" | "settings" | "first-available";
};

function parseModelArgument(value: string): { providerId: string; modelId: string } | undefined {
  const raw = value.trim();
  const index = raw.indexOf(":");
  if (index <= 0 || index === raw.length - 1) return undefined;
  return { providerId: raw.slice(0, index).trim(), modelId: raw.slice(index + 1).trim() };
}

function providerUsable(provider: CustomProvider, modelId: string): boolean {
  return (
    provider.enabled !== false &&
    provider.activeModels.includes(modelId) &&
    isImageGenerationModel(provider, modelId)
  );
}

const NO_MODEL_ERROR =
  "没有可用的生图模型。请到「设置 → 供应商」里启用一个生图模型（如 gpt-image-1 / gemini-3-pro-image），或在图像生成设置里指定默认生图模型，然后重试。";

/**
 * 选模型：显式参数 > 设置里的默认生图模型 > 第一个启用供应商里第一个启用的
 * image 类型模型。每一层都要求模型仍然启用且仍然是 image 类型。
 */
export function selectImageGenerationModel(
  settings: ImageGenerationToolSettings,
  modelArgument?: string,
): SelectedImageModel {
  if (modelArgument?.trim()) {
    const parsed = parseModelArgument(modelArgument);
    if (!parsed) {
      throw new Error(`model 必须写成 "<providerId>:<modelId>"，收到：${modelArgument}`);
    }
    const provider = settings.customProviders.find((item) => item.id === parsed.providerId);
    if (!provider) throw new Error(`找不到供应商 ${parsed.providerId}。`);
    if (!providerUsable(provider, parsed.modelId)) {
      throw new Error(
        `${parsed.providerId}:${parsed.modelId} 不是一个已启用的生图模型。${NO_MODEL_ERROR}`,
      );
    }
    return { provider, modelId: parsed.modelId, source: "argument" };
  }

  const preferred = settings.imageGeneration?.defaultModel;
  if (preferred) {
    const provider = settings.customProviders.find(
      (item) => item.id === preferred.customProviderId,
    );
    if (provider && providerUsable(provider, preferred.model)) {
      return { provider, modelId: preferred.model, source: "settings" };
    }
  }

  for (const provider of settings.customProviders) {
    if (provider.enabled === false) continue;
    const [first] = listImageGenerationModels(provider);
    if (first) return { provider, modelId: first, source: "first-available" };
  }
  throw new Error(NO_MODEL_ERROR);
}

const MIME_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
};

function extensionForMime(mimeType: string): string {
  return MIME_EXTENSIONS[mimeType.trim().toLowerCase()] ?? "png";
}

/** yyyyMMdd-HHmmss（本地时区），与工作区里人读的文件名习惯一致。 */
export function imageFileTimestamp(at: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`,
    `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`,
  ].join("-");
}

type ImageGenerationInvokeArgs = {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  useSystemProxy: boolean;
  route: ImageGenerationRoute;
  providerId: string;
  timeoutMs: number;
};

type RawImageResponse = { status: number; latency_ms: number; body: string };

/**
 * 桌面端拿明文 Key 直接走 Tauri 命令；WebUI 脱敏态不带鉴权头，由桌面端按
 * provider_id + credential_id 从落库配置补 Key（并限制请求主机）。与
 * providerUtils.checkProviderModel 的两条分支同构。
 */
async function sendImageGenerationRequest(
  args: ImageGenerationInvokeArgs,
  signal?: AbortSignal,
): Promise<RawImageResponse> {
  const headerEntries = Object.entries(args.headers);
  if (isGatewayWebuiRuntime()) {
    return (await invoke("gateway_provider_generate_image", {
      url: args.url,
      headers: headerEntries.map(([key, value]) => ({ key, value })),
      body: args.body,
      use_system_proxy: args.useSystemProxy,
      provider_id: args.providerId,
      credential_id: args.route.credentialId,
      protocol: args.route.protocol,
      ...(args.route.auth?.headerName ? { auth_header_name: args.route.auth.headerName } : {}),
      ...(typeof args.route.auth?.prefix === "string"
        ? { auth_prefix: args.route.auth.prefix }
        : {}),
      timeout_ms: args.timeoutMs,
    })) as RawImageResponse;
  }
  const runId = createToolRunId("imagegen", "");
  return await invokeWithAbort<RawImageResponse>(
    "provider_generate_image",
    {
      url: args.url,
      headers: headerEntries,
      body: args.body,
      use_system_proxy: args.useSystemProxy,
      timeout_ms: args.timeoutMs,
    },
    signal,
    { onAbort: () => requestRuntimeCancel(runId) },
  );
}

async function downloadRemoteImage(
  url: string,
  useSystemProxy: boolean,
  signal?: AbortSignal,
): Promise<{ mime_type: string; data: string }> {
  if (isGatewayWebuiRuntime()) {
    return (await invoke("gateway_provider_download_image", {
      url,
      use_system_proxy: useSystemProxy,
    })) as { mime_type: string; data: string };
  }
  const runId = createToolRunId("imagedl", "");
  return await invokeWithAbort<{ mime_type: string; data: string }>(
    "provider_download_image",
    { url, use_system_proxy: useSystemProxy },
    signal,
    { onAbort: () => requestRuntimeCancel(runId) },
  );
}

export function createImageGenerationTools(params: {
  workdir: string;
  /** 实时读设置（供应商列表与默认生图模型），不吃轮级快照。 */
  getSettings: () => ImageGenerationToolSettings;
  resolveHomeDir?: () => Promise<string>;
  /** 测试注入点；缺省用真实的 Tauri / 网关调用。 */
  sendRequest?: typeof sendImageGenerationRequest;
  downloadImage?: typeof downloadRemoteImage;
  now?: () => Date;
}): BuiltinToolBundle {
  const pathResolver = new ToolPathResolver({
    workdir: params.workdir,
    resolveHomeDir: params.resolveHomeDir,
  });
  const send = params.sendRequest ?? sendImageGenerationRequest;
  const download = params.downloadImage ?? downloadRemoteImage;
  const now = params.now ?? (() => new Date());

  async function saveImage(
    saveTo: string,
    fileName: string,
    image: { mimeType: string; base64: string },
  ): Promise<string> {
    // 用 Write 工具那条完全一样的路径解析：越界、UNC、~ 展开与符号链接都由
    // ToolPathResolver + Rust 侧 resolve_scoped_fs_path 兜住，这里不另开通路。
    const resolved = await pathResolver.resolvePath(`${saveTo}/${fileName}`, {
      label: "generate_image.save_to",
      intent: "write",
      required: true,
    });
    if (!resolved.relativePath) {
      throw new Error("generate_image.save_to must identify a directory inside the workspace");
    }
    await invokeFs("fs_write_text", {
      workdir: resolved.root,
      path: resolved.relativePath,
      content: image.base64,
      mode: "rewrite",
      encoding: "base64",
    });
    return resolved.displayPath;
  }

  async function execute(
    toolCall: ToolCall,
    signal?: AbortSignal,
  ): Promise<{ content: ToolResultMessage["content"]; details: Record<string, unknown> }> {
    const args = (toolCall.arguments ?? {}) as Record<string, unknown>;
    const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
    if (!prompt) throw new Error("generate_image.prompt is required");
    const count = clampImageCount(typeof args.count === "number" ? args.count : undefined);
    const size = typeof args.size === "string" && args.size.trim() ? args.size.trim() : undefined;
    const quality =
      typeof args.quality === "string" && args.quality.trim() ? args.quality.trim() : undefined;
    const saveTo =
      typeof args.save_to === "string" && args.save_to.trim()
        ? args.save_to.trim().replace(/\/+$/, "")
        : DEFAULT_SAVE_DIR;

    const settings = params.getSettings();
    const selected = selectImageGenerationModel(
      settings,
      typeof args.model === "string" ? args.model : undefined,
    );
    const credentials = getProviderCredentials(selected.provider);
    const route = resolveImageGenerationRoute(selected.provider, selected.modelId);
    if (!route) {
      throw new Error(
        `${selected.provider.name} 上没有可用于图像生成的接口：需要一个已启用的 OpenAI 兼容端点（/images/generations）或 Gemini 端点（generateContent）。`,
      );
    }
    if (!route.requestUrl) {
      throw new Error(`${selected.provider.name} 的端点地址为空，无法拼出图像生成请求地址。`);
    }
    // 明文 Key 只在桌面端存在；WebUI 脱敏态留空，由桌面端按 credentialId 补。
    const credential = credentials.find((item) => item.id === route.credentialId);
    const keyed =
      resolveImageGenerationRoute(selected.provider, selected.modelId, {
        apiKey: credential?.apiKey ?? "",
        credentialId: route.credentialId,
      }) ?? route;
    const request = buildImageGenerationRequest(keyed, { prompt, count, size, quality });

    const startedAt = Date.now();
    const response = await send(
      {
        url: request.url,
        headers: request.headers,
        body: request.body,
        useSystemProxy: selected.provider.useSystemProxy === true,
        route: keyed,
        providerId: selected.provider.id,
        timeoutMs: GENERATE_TIMEOUT_MS,
      },
      signal,
    );
    const parsed = parseImageGenerationResponse(keyed.kind, response.status, response.body);
    if (!parsed.ok) {
      throw new Error(
        `图像生成失败（${parsed.kind ?? "unknown"}）：${parsed.error ?? `HTTP ${response.status}`}`,
      );
    }

    // dall-e 这类只回 URL 的结果先下载成 base64，再和内联结果一起落盘。
    const inlined: { mimeType: string; base64: string }[] = [];
    for (const image of parsed.images as GeneratedImage[]) {
      if (image.base64) {
        inlined.push({ mimeType: image.mimeType, base64: image.base64 });
        continue;
      }
      if (!image.remoteUrl) continue;
      const downloaded = await download(
        image.remoteUrl,
        selected.provider.useSystemProxy === true,
        signal,
      );
      inlined.push({ mimeType: downloaded.mime_type, base64: downloaded.data });
    }
    if (inlined.length === 0) throw new Error("图像生成失败：响应里没有可用的图片数据。");

    const stamp = imageFileTimestamp(now());
    const saved: { path: string; mimeType: string }[] = [];
    for (const [index, image] of inlined.entries()) {
      const fileName = `${stamp}-${index + 1}.${extensionForMime(image.mimeType)}`;
      saved.push({ path: await saveImage(saveTo, fileName, image), mimeType: image.mimeType });
    }

    const elapsedMs = Date.now() - startedAt;
    const summary = [
      `Generated ${inlined.length} image${inlined.length > 1 ? "s" : ""} with ${selected.provider.name} / ${selected.modelId} (${keyed.kind}) in ${elapsedMs}ms.`,
      `Saved to:\n${saved.map((item) => `  ${item.path}`).join("\n")}`,
      ...(parsed.revisedPrompt ? [`Revised prompt: ${parsed.revisedPrompt}`] : []),
      ...(parsed.texts.length > 0 ? [parsed.texts.join("\n")] : []),
    ].join("\n");

    return {
      content: [
        { type: "text", text: summary },
        ...inlined.map((image) => ({
          type: "image" as const,
          data: image.base64,
          mimeType: image.mimeType,
        })),
      ],
      details: {
        kind: "generate_image",
        api: keyed.kind,
        providerId: selected.provider.id,
        providerName: selected.provider.name,
        model: selected.modelId,
        modelSource: selected.source,
        count: inlined.length,
        requestedCount: count,
        elapsedMs,
        images: saved,
        ...(size ? { size } : {}),
        ...(quality ? { quality } : {}),
        ...(parsed.revisedPrompt ? { revisedPrompt: parsed.revisedPrompt } : {}),
      },
    };
  }

  async function executeToolCall(
    toolCall: ToolCall,
    signal?: AbortSignal,
  ): Promise<ToolResultMessage> {
    const timestamp = Date.now();
    const base = {
      role: "toolResult" as const,
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      timestamp,
    };
    if (signal?.aborted) {
      return {
        ...base,
        content: [{ type: "text", text: "Cancelled" }],
        details: {},
        isError: true,
      };
    }
    if (toolCall.name !== GENERATE_IMAGE_TOOL_NAME) {
      return {
        ...base,
        content: [{ type: "text", text: `Unknown tool: ${toolCall.name}` }],
        details: {},
        isError: true,
      };
    }
    try {
      const { content, details } = await execute(toolCall, signal);
      return { ...base, content, details, isError: false };
    } catch (error) {
      return {
        ...base,
        content: [
          {
            type: "text",
            text: `generate_image failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        details: {},
        isError: true,
      };
    }
  }

  return {
    groupId: "system",
    tools: [toolGenerateImage],
    executeToolCall,
    metadataByName: createBuiltinMetadataMap([
      [
        GENERATE_IMAGE_TOOL_NAME,
        {
          groupId: "system",
          kind: "system",
          isReadOnly: false,
          displayCategory: "other",
        },
      ],
    ]),
  };
}
