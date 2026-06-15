import type { Tool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { invoke } from "@tauri-apps/api/core";

import { type BuiltinToolBundle, createBuiltinMetadataMap } from "./builtinTypes";

type SystemHttpGetResponse = {
  url: string;
  status: number;
  ok: boolean;
  body: string;
  content_type?: string | null;
};

type CrateBayCliResult = {
  ok: boolean;
  exitCode?: number | null;
  stdout: string;
  stderr: string;
  json?: unknown;
};

type CrateBayStatusResponse = {
  installed: boolean;
  repository: string;
  installDir: string;
  binaryPath?: string | null;
  version?: string | null;
  latestRelease?: unknown;
  runtime?: CrateBayCliResult | null;
  error?: string | null;
};

export type SystemToolRuntimeScope = "chat" | "cron_auto_prompt";

type SystemToolDefinition = {
  id: string;
  label: string;
  name: string;
  description: string;
  parameters: Tool["parameters"];
  isReadOnly: boolean;
  runtimeScopes: readonly SystemToolRuntimeScope[];
  execute: (toolCall: ToolCall, signal?: AbortSignal) => Promise<ToolResultMessage>;
};

function asErrorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return items.length > 0 ? items : undefined;
}

function toolText(value: unknown) {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function toolResult(params: {
  toolCall: ToolCall;
  text: string;
  details: unknown;
  isError?: boolean;
}): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: params.toolCall.id,
    toolName: params.toolCall.name,
    content: [{ type: "text", text: params.text }],
    details: params.details,
    isError: params.isError ?? false,
    timestamp: Date.now(),
  };
}

function installRequiredResult(toolCall: ToolCall): ToolResultMessage {
  return toolResult({
    toolCall,
    isError: true,
    text:
      "CrateBay sandbox is not installed. Enable it from the Sandbox panel or run CrateBayInstall, then retry this tool.",
    details: { kind: "cratebay_install_required" },
  });
}

function cratebayCliText(result: CrateBayCliResult) {
  if (result.json !== undefined && result.json !== null) {
    return toolText(result.json);
  }
  return [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n") || "(no output)";
}

async function cratebayStatus(includePrerelease = false): Promise<CrateBayStatusResponse> {
  return invoke<CrateBayStatusResponse>("cratebay_status", {
    include_prerelease: includePrerelease,
  });
}

async function ensureCrateBayInstalled(toolCall: ToolCall): Promise<ToolResultMessage | null> {
  try {
    const status = await cratebayStatus(false);
    return status.installed ? null : installRequiredResult(toolCall);
  } catch (err) {
    return toolResult({
      toolCall,
      isError: true,
      text: `Unable to check CrateBay sandbox install state: ${asErrorMessage(err)}`,
      details: { kind: "cratebay_status_error" },
    });
  }
}

async function executeCrateBayCliTool(
  toolCall: ToolCall,
  command: string,
  payload: Record<string, unknown>,
): Promise<ToolResultMessage> {
  const installResult = await ensureCrateBayInstalled(toolCall);
  if (installResult) return installResult;

  try {
    const result = await invoke<CrateBayCliResult>(command, payload);
    return toolResult({
      toolCall,
      text: cratebayCliText(result),
      details: result,
      isError: !result.ok,
    });
  } catch (err) {
    return toolResult({
      toolCall,
      text: `CrateBay command failed: ${asErrorMessage(err)}`,
      details: { kind: "cratebay_command_error" },
      isError: true,
    });
  }
}

function generatedSandboxPodName(toolCall: ToolCall) {
  const raw = `${toolCall.id || toolCall.name || "run"}`.toLowerCase();
  const suffix = raw
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `liveagent-${suffix || "run"}`;
}

async function executeCrateBaySandboxRun(
  toolCall: ToolCall,
  signal?: AbortSignal,
): Promise<ToolResultMessage> {
  const installResult = await ensureCrateBayInstalled(toolCall);
  if (installResult) return installResult;

  const args = asRecord(toolCall.arguments);
  const podName = optionalString(args.pod_name) ?? generatedSandboxPodName(toolCall);
  const keepContainer = optionalBoolean(args.keep_container);
  const keepPod = optionalBoolean(args.keep_pod) ?? keepContainer === true;
  const autoStart = optionalBoolean(args.auto_start) ?? true;
  const steps: Array<{
    name: string;
    command: string;
    ok: boolean;
    result?: CrateBayCliResult;
    error?: string;
  }> = [];
  let podCreated = false;
  let runResult: CrateBayCliResult | null = null;

  const invokeStep = async (
    name: string,
    command: string,
    payload: Record<string, unknown>,
    options: { respectAbort?: boolean } = {},
  ) => {
    if (options.respectAbort !== false && signal?.aborted) {
      throw new Error("Cancelled");
    }
    try {
      const result = await invoke<CrateBayCliResult>(command, payload);
      steps.push({ name, command, ok: result.ok, result });
      return result;
    } catch (err) {
      const message = asErrorMessage(err);
      steps.push({ name, command, ok: false, error: message });
      throw err;
    }
  };

  let commandError: string | null = null;
  try {
    if (autoStart) {
      const start = await invokeStep("runtime_start", "cratebay_runtime_start", {});
      if (!start.ok) {
        commandError = "CrateBay runtime did not start cleanly.";
      }
    }

    if (commandError === null) {
      const createPod = await invokeStep("pod_create", "cratebay_engine_pod_create", {
        name: podName,
        driver: optionalString(args.driver),
        internal: optionalBoolean(args.internal),
        enable_ipv6: optionalBoolean(args.enable_ipv6),
      });
      podCreated = createPod.ok;
      if (!createPod.ok) {
        commandError = `CrateBay pod ${podName} was not created.`;
      }
    }

    if (commandError === null) {
      const request = {
        ...containerRunRequest(args),
        image: optionalString(args.image) ?? "cratebay-ubuntu-base:v1",
        pod: podName,
        remove: keepContainer !== true,
        keep: keepContainer,
      };
      runResult = await invokeStep("container_run", "cratebay_engine_container_run", {
        request,
      });
      if (!runResult.ok) {
        commandError = "CrateBay sandbox container run failed.";
      }
    }
  } catch (err) {
    commandError = asErrorMessage(err);
  } finally {
    if (podCreated && !keepPod) {
      try {
        await invokeStep("pod_cleanup", "cratebay_engine_pod_remove", {
          name: podName,
        }, { respectAbort: false });
      } catch (err) {
        commandError = commandError ?? `CrateBay sandbox cleanup failed: ${asErrorMessage(err)}`;
      }
    }
  }

  const failedStep = steps.find((step) => !step.ok);
  const text = [
    `CrateBay sandbox pod: ${podName}`,
    autoStart ? "runtime: started or already running" : "runtime: start skipped",
    `pod cleanup: ${keepPod ? "kept" : "requested"}`,
    runResult ? "" : null,
    runResult ? cratebayCliText(runResult) : null,
    commandError ? `CrateBay sandbox run issue: ${commandError}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  return toolResult({
    toolCall,
    text,
    details: {
      kind: "cratebay_sandbox_run",
      podName,
      keepPod,
      keepContainer: keepContainer ?? false,
      steps,
    },
    isError: Boolean(commandError || failedStep),
  });
}

async function executeHttpGetTest(
  toolCall: ToolCall,
  _signal?: AbortSignal,
): Promise<ToolResultMessage> {
  const now = Date.now();

  try {
    const result = await invoke<SystemHttpGetResponse>("system_http_get_test");
    const text = [
      `GET ${result.url}`,
      `status: ${result.status}`,
      result.content_type ? `content-type: ${result.content_type}` : "",
      "",
      result.body || "(empty body)",
    ]
      .filter(Boolean)
      .join("\n");

    return {
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: [{ type: "text", text }],
      details: result,
      isError: !result.ok,
      timestamp: now,
    };
  } catch (err) {
    return {
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: [{ type: "text", text: `Test endpoint request failed: ${asErrorMessage(err)}` }],
      details: {},
      isError: true,
      timestamp: now,
    };
  }
}

async function executeCrateBayStatus(toolCall: ToolCall): Promise<ToolResultMessage> {
  try {
    const args = asRecord(toolCall.arguments);
    const status = await cratebayStatus(optionalBoolean(args.include_prerelease) ?? false);
    return toolResult({
      toolCall,
      text: toolText(status),
      details: status,
      isError: Boolean(status.error),
    });
  } catch (err) {
    return toolResult({
      toolCall,
      text: `CrateBay status failed: ${asErrorMessage(err)}`,
      details: { kind: "cratebay_status_error" },
      isError: true,
    });
  }
}

async function executeCrateBayInstall(toolCall: ToolCall): Promise<ToolResultMessage> {
  try {
    const args = asRecord(toolCall.arguments);
    const result = await invoke<CrateBayStatusResponse>("cratebay_install", {
      include_prerelease: optionalBoolean(args.include_prerelease) ?? false,
    });
    return toolResult({
      toolCall,
      text: toolText(result),
      details: result,
      isError: !result.installed,
    });
  } catch (err) {
    return toolResult({
      toolCall,
      text: `CrateBay install failed: ${asErrorMessage(err)}`,
      details: { kind: "cratebay_install_error" },
      isError: true,
    });
  }
}

function containerCreateRequest(args: Record<string, unknown>) {
  return {
    name: optionalString(args.name) ?? "",
    image: optionalString(args.image) ?? "",
    cpu: optionalNumber(args.cpu),
    memory: optionalNumber(args.memory),
    command: optionalString(args.command),
    entrypoint: optionalString(args.entrypoint),
    workingDir: optionalString(args.working_dir),
    env: optionalStringArray(args.env),
    publish: optionalStringArray(args.publish),
    volume: optionalStringArray(args.volume),
    pod: optionalString(args.pod),
    network: optionalString(args.network),
    user: optionalString(args.user),
    readOnly: optionalBoolean(args.read_only),
    noStart: optionalBoolean(args.no_start),
  };
}

function containerRunRequest(args: Record<string, unknown>) {
  return {
    image: optionalString(args.image) ?? "",
    command: optionalStringArray(args.command) ?? [],
    name: optionalString(args.name),
    env: optionalStringArray(args.env),
    volume: optionalStringArray(args.volume),
    cpu: optionalNumber(args.cpu),
    memory: optionalNumber(args.memory),
    workingDir: optionalString(args.working_dir),
    entrypoint: optionalString(args.entrypoint),
    pod: optionalString(args.pod),
    network: optionalString(args.network),
    user: optionalString(args.user),
    readOnly: optionalBoolean(args.read_only),
    noPull: optionalBoolean(args.no_pull),
    remove: optionalBoolean(args.remove),
    keep: optionalBoolean(args.keep),
    timeout: optionalNumber(args.timeout),
    maxOutputBytes: optionalNumber(args.max_output_bytes),
  };
}

function terminalOpenRequest(args: Record<string, unknown>) {
  return {
    id: optionalString(args.id) ?? "",
    sessionId: optionalString(args.session_id),
    workingDir: optionalString(args.working_dir),
    cols: optionalNumber(args.cols),
    rows: optionalNumber(args.rows),
    command: optionalStringArray(args.command),
  };
}

function terminalSessionRequest(args: Record<string, unknown>) {
  return {
    id: optionalString(args.id) ?? "",
    sessionId: optionalString(args.session_id) ?? "",
  };
}

const SELECTABLE_SYSTEM_TOOL_DEFINITIONS = [
  {
    id: "http_get_test",
    label: "本地 HTTP Test",
    name: "HttpGetTest",
    description: "Call the network test endpoint and return the response body.",
    parameters: Type.Object({}),
    isReadOnly: true,
    runtimeScopes: ["chat", "cron_auto_prompt"],
    execute: executeHttpGetTest,
  },
  {
    id: "cratebay_status",
    label: "CrateBay Status",
    name: "CrateBayStatus",
    description: "Check whether the optional CrateBay sandbox backend is installed and report CrateBay Engine VM state.",
    parameters: Type.Object({
      include_prerelease: Type.Optional(Type.Boolean()),
    }),
    isReadOnly: true,
    runtimeScopes: ["chat", "cron_auto_prompt"],
    execute: executeCrateBayStatus,
  },
  {
    id: "cratebay_install",
    label: "CrateBay Install",
    name: "CrateBayInstall",
    description: "Download, verify, and install the optional CrateBay headless sandbox backend from GitHub Releases.",
    parameters: Type.Object({
      include_prerelease: Type.Optional(Type.Boolean()),
    }),
    isReadOnly: false,
    runtimeScopes: ["chat"],
    execute: executeCrateBayInstall,
  },
  {
    id: "cratebay_list_containers",
    label: "CrateBay Containers",
    name: "CrateBayListContainers",
    description: "List CrateBay sandbox containers through the CrateBay Engine CLI surface.",
    parameters: Type.Object({
      all: Type.Optional(Type.Boolean()),
    }),
    isReadOnly: true,
    runtimeScopes: ["chat", "cron_auto_prompt"],
    execute: (toolCall) =>
      executeCrateBayCliTool(toolCall, "cratebay_engine_containers", {}),
  },
  {
    id: "cratebay_create_container",
    label: "CrateBay Create",
    name: "CrateBayCreateContainer",
    description: "Create a real CrateBay sandbox container through the CrateBay Engine CLI surface.",
    parameters: Type.Object({
      name: Type.String(),
      image: Type.String(),
      command: Type.Optional(Type.String()),
      entrypoint: Type.Optional(Type.String()),
      working_dir: Type.Optional(Type.String()),
      env: Type.Optional(Type.Array(Type.String())),
      publish: Type.Optional(Type.Array(Type.String())),
      volume: Type.Optional(Type.Array(Type.String())),
      pod: Type.Optional(Type.String()),
      network: Type.Optional(Type.String()),
      user: Type.Optional(Type.String()),
      read_only: Type.Optional(Type.Boolean()),
      no_start: Type.Optional(Type.Boolean()),
      cpu: Type.Optional(Type.Number()),
      memory: Type.Optional(Type.Number()),
    }),
    isReadOnly: false,
    runtimeScopes: ["chat"],
    execute: (toolCall) =>
      executeCrateBayCliTool(toolCall, "cratebay_engine_container_create", {
        request: containerCreateRequest(asRecord(toolCall.arguments)),
      }),
  },
  {
    id: "cratebay_run",
    label: "CrateBay Run",
    name: "CrateBayRun",
    description: "Run a one-shot sandbox container through the CrateBay Engine CLI surface and return captured output.",
    parameters: Type.Object({
      image: Type.String(),
      command: Type.Array(Type.String()),
      name: Type.Optional(Type.String()),
      env: Type.Optional(Type.Array(Type.String())),
      volume: Type.Optional(Type.Array(Type.String())),
      working_dir: Type.Optional(Type.String()),
      entrypoint: Type.Optional(Type.String()),
      pod: Type.Optional(Type.String()),
      network: Type.Optional(Type.String()),
      user: Type.Optional(Type.String()),
      read_only: Type.Optional(Type.Boolean()),
      no_pull: Type.Optional(Type.Boolean()),
      remove: Type.Optional(Type.Boolean()),
      keep: Type.Optional(Type.Boolean()),
      timeout: Type.Optional(Type.Number()),
      max_output_bytes: Type.Optional(Type.Number()),
      cpu: Type.Optional(Type.Number()),
      memory: Type.Optional(Type.Number()),
    }),
    isReadOnly: false,
    runtimeScopes: ["chat", "cron_auto_prompt"],
    execute: (toolCall) =>
      executeCrateBayCliTool(toolCall, "cratebay_engine_container_run", {
        request: containerRunRequest(asRecord(toolCall.arguments)),
      }),
  },
  {
    id: "cratebay_sandbox_run",
    label: "CrateBay Sandbox Run",
    name: "CrateBaySandboxRun",
    description:
      "Start CrateBay Engine if needed, create an ephemeral CrateBay pod, run a one-shot container through the native Engine API, and clean up the pod by default.",
    parameters: Type.Object({
      command: Type.Array(Type.String()),
      image: Type.Optional(Type.String()),
      pod_name: Type.Optional(Type.String()),
      name: Type.Optional(Type.String()),
      env: Type.Optional(Type.Array(Type.String())),
      volume: Type.Optional(Type.Array(Type.String())),
      working_dir: Type.Optional(Type.String()),
      entrypoint: Type.Optional(Type.String()),
      driver: Type.Optional(Type.String()),
      internal: Type.Optional(Type.Boolean()),
      enable_ipv6: Type.Optional(Type.Boolean()),
      network: Type.Optional(Type.String()),
      user: Type.Optional(Type.String()),
      read_only: Type.Optional(Type.Boolean()),
      no_pull: Type.Optional(Type.Boolean()),
      keep_container: Type.Optional(Type.Boolean()),
      keep_pod: Type.Optional(Type.Boolean()),
      auto_start: Type.Optional(Type.Boolean()),
      timeout: Type.Optional(Type.Number()),
      max_output_bytes: Type.Optional(Type.Number()),
      cpu: Type.Optional(Type.Number()),
      memory: Type.Optional(Type.Number()),
    }),
    isReadOnly: false,
    runtimeScopes: ["chat", "cron_auto_prompt"],
    execute: executeCrateBaySandboxRun,
  },
  {
    id: "cratebay_exec",
    label: "CrateBay Exec",
    name: "CrateBayExec",
    description: "Execute a command inside an existing CrateBay sandbox container through the CrateBay Engine CLI surface.",
    parameters: Type.Object({
      id: Type.String(),
      command: Type.Array(Type.String()),
      working_dir: Type.Optional(Type.String()),
      timeout: Type.Optional(Type.Number()),
      max_output_bytes: Type.Optional(Type.Number()),
    }),
    isReadOnly: false,
    runtimeScopes: ["chat", "cron_auto_prompt"],
    execute: (toolCall) => {
      const args = asRecord(toolCall.arguments);
      return executeCrateBayCliTool(toolCall, "cratebay_engine_container_exec", {
        request: {
          id: optionalString(args.id) ?? "",
          command: optionalStringArray(args.command) ?? [],
          workingDir: optionalString(args.working_dir),
          timeout: optionalNumber(args.timeout),
          maxOutputBytes: optionalNumber(args.max_output_bytes),
        },
      });
    },
  },
  {
    id: "cratebay_logs",
    label: "CrateBay Logs",
    name: "CrateBayLogs",
    description: "Read logs from an existing CrateBay sandbox container through the CrateBay Engine CLI surface.",
    parameters: Type.Object({
      id: Type.String(),
      tail: Type.Optional(Type.Number()),
      timestamps: Type.Optional(Type.Boolean()),
    }),
    isReadOnly: true,
    runtimeScopes: ["chat", "cron_auto_prompt"],
    execute: (toolCall) => {
      const args = asRecord(toolCall.arguments);
      return executeCrateBayCliTool(toolCall, "cratebay_engine_container_logs", {
        request: {
          id: optionalString(args.id) ?? "",
          tail: optionalNumber(args.tail),
          timestamps: optionalBoolean(args.timestamps),
        },
      });
    },
  },
  {
    id: "cratebay_remove_container",
    label: "CrateBay Remove",
    name: "CrateBayRemoveContainer",
    description: "Remove a CrateBay sandbox container through the CrateBay Engine CLI surface.",
    parameters: Type.Object({
      id: Type.String(),
      force: Type.Optional(Type.Boolean()),
    }),
    isReadOnly: false,
    runtimeScopes: ["chat"],
    execute: (toolCall) => {
      const args = asRecord(toolCall.arguments);
      return executeCrateBayCliTool(toolCall, "cratebay_engine_container_remove", {
        id: optionalString(args.id) ?? "",
        force: optionalBoolean(args.force) ?? false,
      });
    },
  },
  {
    id: "cratebay_runtime_status",
    label: "CrateBay Engine VM",
    name: "CrateBayEngineVmStatus",
    description: "Read the CrateBay-managed Engine VM status.",
    parameters: Type.Object({}),
    isReadOnly: true,
    runtimeScopes: ["chat", "cron_auto_prompt"],
    execute: (toolCall) => executeCrateBayCliTool(toolCall, "cratebay_runtime_status", {}),
  },
  {
    id: "cratebay_runtime_start",
    label: "CrateBay Engine VM Start",
    name: "CrateBayEngineVmStart",
    description: "Start the CrateBay-managed Engine VM.",
    parameters: Type.Object({}),
    isReadOnly: false,
    runtimeScopes: ["chat"],
    execute: (toolCall) => executeCrateBayCliTool(toolCall, "cratebay_runtime_start", {}),
  },
  {
    id: "cratebay_runtime_stop",
    label: "CrateBay Engine VM Stop",
    name: "CrateBayEngineVmStop",
    description: "Stop the CrateBay-managed Engine VM.",
    parameters: Type.Object({}),
    isReadOnly: false,
    runtimeScopes: ["chat"],
    execute: (toolCall) => executeCrateBayCliTool(toolCall, "cratebay_runtime_stop", {}),
  },
  {
    id: "cratebay_engine_status",
    label: "CrateBay Engine Status",
    name: "CrateBayEngineStatus",
    description: "Read the native CrateBay Engine contract from the installed sandbox backend.",
    parameters: Type.Object({}),
    isReadOnly: true,
    runtimeScopes: ["chat", "cron_auto_prompt"],
    execute: (toolCall) => executeCrateBayCliTool(toolCall, "cratebay_engine_status", {}),
  },
  {
    id: "cratebay_engine_substrate",
    label: "CrateBay Engine Substrate",
    name: "CrateBayEngineSubstrate",
    description: "Inspect the CrateBay-owned VM, containerd shim lifecycle, CNI network manager, storage manager, and compatibility endpoint.",
    parameters: Type.Object({}),
    isReadOnly: true,
    runtimeScopes: ["chat", "cron_auto_prompt"],
    execute: (toolCall) => executeCrateBayCliTool(toolCall, "cratebay_engine_substrate", {}),
  },
  {
    id: "cratebay_engine_storage_gc",
    label: "CrateBay Storage GC",
    name: "CrateBayStorageGc",
    description: "Run CrateBay storage garbage collection for exited sandbox metadata/logs. Defaults to dry-run unless apply is true.",
    parameters: Type.Object({
      apply: Type.Optional(Type.Boolean()),
      prune_exited_containers: Type.Optional(Type.Boolean()),
    }),
    isReadOnly: false,
    runtimeScopes: ["chat", "cron_auto_prompt"],
    execute: (toolCall) => {
      const args = asRecord(toolCall.arguments);
      return executeCrateBayCliTool(toolCall, "cratebay_engine_storage_gc", {
        apply: optionalBoolean(args.apply) ?? false,
        prune_exited_containers: optionalBoolean(args.prune_exited_containers) ?? true,
      });
    },
  },
  {
    id: "cratebay_engine_shim_tasks",
    label: "CrateBay Shim Tasks",
    name: "CrateBayShimTasks",
    description: "List CrateBay-managed containerd shim tasks and their lifecycle state.",
    parameters: Type.Object({}),
    isReadOnly: true,
    runtimeScopes: ["chat", "cron_auto_prompt"],
    execute: (toolCall) => executeCrateBayCliTool(toolCall, "cratebay_engine_shim_tasks", {}),
  },
  {
    id: "cratebay_engine_shim_reap",
    label: "CrateBay Reap Shim Task",
    name: "CrateBayReapShimTask",
    description: "Reap exited CrateBay shim task metadata/logs. Defaults to dry-run unless apply is true.",
    parameters: Type.Object({
      id: Type.String(),
      apply: Type.Optional(Type.Boolean()),
    }),
    isReadOnly: false,
    runtimeScopes: ["chat", "cron_auto_prompt"],
    execute: (toolCall) => {
      const args = asRecord(toolCall.arguments);
      return executeCrateBayCliTool(toolCall, "cratebay_engine_shim_reap", {
        id: optionalString(args.id) ?? "",
        apply: optionalBoolean(args.apply) ?? false,
      });
    },
  },
  {
    id: "cratebay_engine_containers",
    label: "CrateBay Native Containers",
    name: "CrateBayNativeContainers",
    description: "List containers through the native CrateBay Engine API.",
    parameters: Type.Object({}),
    isReadOnly: true,
    runtimeScopes: ["chat", "cron_auto_prompt"],
    execute: (toolCall) => executeCrateBayCliTool(toolCall, "cratebay_engine_containers", {}),
  },
  {
    id: "cratebay_engine_images",
    label: "CrateBay Native Images",
    name: "CrateBayNativeImages",
    description: "List images through the native CrateBay Engine API.",
    parameters: Type.Object({}),
    isReadOnly: true,
    runtimeScopes: ["chat", "cron_auto_prompt"],
    execute: (toolCall) => executeCrateBayCliTool(toolCall, "cratebay_engine_images", {}),
  },
  {
    id: "cratebay_engine_pull_image",
    label: "CrateBay Native Pull Image",
    name: "CrateBayNativePullImage",
    description: "Pull an image through the native CrateBay Engine API using containerd first.",
    parameters: Type.Object({
      image: Type.String(),
      tag: Type.Optional(Type.String()),
    }),
    isReadOnly: false,
    runtimeScopes: ["chat", "cron_auto_prompt"],
    execute: (toolCall) => {
      const args = asRecord(toolCall.arguments);
      return executeCrateBayCliTool(toolCall, "cratebay_engine_image_pull", {
        image: optionalString(args.image) ?? "",
        tag: optionalString(args.tag),
      });
    },
  },
  {
    id: "cratebay_engine_inspect_image",
    label: "CrateBay Native Inspect Image",
    name: "CrateBayNativeInspectImage",
    description: "Inspect an image through the native CrateBay Engine API.",
    parameters: Type.Object({
      id: Type.String(),
    }),
    isReadOnly: true,
    runtimeScopes: ["chat", "cron_auto_prompt"],
    execute: (toolCall) =>
      executeCrateBayCliTool(toolCall, "cratebay_engine_image_inspect", {
        id: optionalString(asRecord(toolCall.arguments).id) ?? "",
      }),
  },
  {
    id: "cratebay_engine_remove_image",
    label: "CrateBay Native Remove Image",
    name: "CrateBayNativeRemoveImage",
    description: "Remove an image through the native CrateBay Engine API.",
    parameters: Type.Object({
      id: Type.String(),
      force: Type.Optional(Type.Boolean()),
    }),
    isReadOnly: false,
    runtimeScopes: ["chat", "cron_auto_prompt"],
    execute: (toolCall) => {
      const args = asRecord(toolCall.arguments);
      return executeCrateBayCliTool(toolCall, "cratebay_engine_image_remove", {
        id: optionalString(args.id) ?? "",
        force: optionalBoolean(args.force) ?? false,
      });
    },
  },
  {
    id: "cratebay_engine_tag_image",
    label: "CrateBay Native Tag Image",
    name: "CrateBayNativeTagImage",
    description: "Tag an image through the native CrateBay Engine API.",
    parameters: Type.Object({
      source: Type.String(),
      target: Type.String(),
    }),
    isReadOnly: false,
    runtimeScopes: ["chat", "cron_auto_prompt"],
    execute: (toolCall) => {
      const args = asRecord(toolCall.arguments);
      return executeCrateBayCliTool(toolCall, "cratebay_engine_image_tag", {
        source: optionalString(args.source) ?? "",
        target: optionalString(args.target) ?? "",
      });
    },
  },
  {
    id: "cratebay_engine_pack_image",
    label: "CrateBay Native Pack Image",
    name: "CrateBayNativePackImage",
    description: "Pack a running CrateBay container root filesystem into an image through the native CrateBay Engine API.",
    parameters: Type.Object({
      container: Type.String(),
      image: Type.String(),
    }),
    isReadOnly: false,
    runtimeScopes: ["chat", "cron_auto_prompt"],
    execute: (toolCall) => {
      const args = asRecord(toolCall.arguments);
      return executeCrateBayCliTool(toolCall, "cratebay_engine_image_pack", {
        container: optionalString(args.container) ?? "",
        image: optionalString(args.image) ?? "",
      });
    },
  },
  {
    id: "cratebay_engine_export_images",
    label: "CrateBay Native Export Images",
    name: "CrateBayNativeExportImages",
    description: "Export one or more images into a tar archive through the native CrateBay Engine API.",
    parameters: Type.Object({
      images: Type.Array(Type.String()),
      output: Type.String(),
    }),
    isReadOnly: false,
    runtimeScopes: ["chat", "cron_auto_prompt"],
    execute: (toolCall) => {
      const args = asRecord(toolCall.arguments);
      return executeCrateBayCliTool(toolCall, "cratebay_engine_image_export", {
        images: optionalStringArray(args.images) ?? [],
        output: optionalString(args.output) ?? "",
      });
    },
  },
  {
    id: "cratebay_engine_import_image",
    label: "CrateBay Native Import Image",
    name: "CrateBayNativeImportImage",
    description: "Import an image tar archive through the native CrateBay Engine API.",
    parameters: Type.Object({
      input: Type.String(),
    }),
    isReadOnly: false,
    runtimeScopes: ["chat", "cron_auto_prompt"],
    execute: (toolCall) =>
      executeCrateBayCliTool(toolCall, "cratebay_engine_image_import", {
        input: optionalString(asRecord(toolCall.arguments).input) ?? "",
      }),
  },
  {
    id: "cratebay_engine_networks",
    label: "CrateBay Native Networks",
    name: "CrateBayNativeNetworks",
    description: "List CrateBay-managed CNI networks through the native CrateBay Engine API.",
    parameters: Type.Object({}),
    isReadOnly: true,
    runtimeScopes: ["chat", "cron_auto_prompt"],
    execute: (toolCall) => executeCrateBayCliTool(toolCall, "cratebay_engine_networks", {}),
  },
  {
    id: "cratebay_engine_inspect_network",
    label: "CrateBay Native Inspect Network",
    name: "CrateBayNativeInspectNetwork",
    description: "Inspect a CrateBay-managed CNI network, including IPAM and attached containers.",
    parameters: Type.Object({
      id: Type.String(),
    }),
    isReadOnly: true,
    runtimeScopes: ["chat", "cron_auto_prompt"],
    execute: (toolCall) =>
      executeCrateBayCliTool(toolCall, "cratebay_engine_network_inspect", {
        id: optionalString(asRecord(toolCall.arguments).id) ?? "",
      }),
  },
  {
    id: "cratebay_engine_create_network",
    label: "CrateBay Native Create Network",
    name: "CrateBayNativeCreateNetwork",
    description: "Create a CrateBay-managed bridge CNI network through the native CrateBay Engine API.",
    parameters: Type.Object({
      name: Type.String(),
      driver: Type.Optional(Type.String()),
      internal: Type.Optional(Type.Boolean()),
      enable_ipv6: Type.Optional(Type.Boolean()),
    }),
    isReadOnly: false,
    runtimeScopes: ["chat", "cron_auto_prompt"],
    execute: (toolCall) => {
      const args = asRecord(toolCall.arguments);
      return executeCrateBayCliTool(toolCall, "cratebay_engine_network_create", {
        name: optionalString(args.name) ?? "",
        driver: optionalString(args.driver),
        internal: optionalBoolean(args.internal),
        enable_ipv6: optionalBoolean(args.enable_ipv6),
      });
    },
  },
  {
    id: "cratebay_engine_remove_network",
    label: "CrateBay Native Remove Network",
    name: "CrateBayNativeRemoveNetwork",
    description: "Remove a network through the native CrateBay Engine API.",
    parameters: Type.Object({
      id: Type.String(),
    }),
    isReadOnly: false,
    runtimeScopes: ["chat", "cron_auto_prompt"],
    execute: (toolCall) =>
      executeCrateBayCliTool(toolCall, "cratebay_engine_network_remove", {
        id: optionalString(asRecord(toolCall.arguments).id) ?? "",
      }),
  },
  {
    id: "cratebay_engine_volumes",
    label: "CrateBay Native Volumes",
    name: "CrateBayNativeVolumes",
    description: "List volumes through the native CrateBay Engine API.",
    parameters: Type.Object({}),
    isReadOnly: true,
    runtimeScopes: ["chat", "cron_auto_prompt"],
    execute: (toolCall) => executeCrateBayCliTool(toolCall, "cratebay_engine_volumes", {}),
  },
  {
    id: "cratebay_engine_inspect_volume",
    label: "CrateBay Native Inspect Volume",
    name: "CrateBayNativeInspectVolume",
    description: "Inspect a CrateBay-managed storage volume, including path and size.",
    parameters: Type.Object({
      name: Type.String(),
    }),
    isReadOnly: true,
    runtimeScopes: ["chat", "cron_auto_prompt"],
    execute: (toolCall) =>
      executeCrateBayCliTool(toolCall, "cratebay_engine_volume_inspect", {
        name: optionalString(asRecord(toolCall.arguments).name) ?? "",
      }),
  },
  {
    id: "cratebay_engine_create_volume",
    label: "CrateBay Native Create Volume",
    name: "CrateBayNativeCreateVolume",
    description: "Create a volume through the native CrateBay Engine API.",
    parameters: Type.Object({
      name: Type.String(),
      driver: Type.Optional(Type.String()),
    }),
    isReadOnly: false,
    runtimeScopes: ["chat", "cron_auto_prompt"],
    execute: (toolCall) => {
      const args = asRecord(toolCall.arguments);
      return executeCrateBayCliTool(toolCall, "cratebay_engine_volume_create", {
        name: optionalString(args.name) ?? "",
        driver: optionalString(args.driver),
      });
    },
  },
  {
    id: "cratebay_engine_remove_volume",
    label: "CrateBay Native Remove Volume",
    name: "CrateBayNativeRemoveVolume",
    description: "Remove a volume through the native CrateBay Engine API.",
    parameters: Type.Object({
      name: Type.String(),
    }),
    isReadOnly: false,
    runtimeScopes: ["chat", "cron_auto_prompt"],
    execute: (toolCall) =>
      executeCrateBayCliTool(toolCall, "cratebay_engine_volume_remove", {
        name: optionalString(asRecord(toolCall.arguments).name) ?? "",
      }),
  },
  {
    id: "cratebay_engine_pods",
    label: "CrateBay Native Pods",
    name: "CrateBayNativePods",
    description: "List CrateBay-managed pod networks through the native CrateBay Engine API.",
    parameters: Type.Object({}),
    isReadOnly: true,
    runtimeScopes: ["chat", "cron_auto_prompt"],
    execute: (toolCall) => executeCrateBayCliTool(toolCall, "cratebay_engine_pods", {}),
  },
  {
    id: "cratebay_engine_create_pod",
    label: "CrateBay Native Create Pod",
    name: "CrateBayNativeCreatePod",
    description: "Create a CrateBay-managed pod network backed by CNI through the native CrateBay Engine API.",
    parameters: Type.Object({
      name: Type.String(),
      driver: Type.Optional(Type.String()),
      internal: Type.Optional(Type.Boolean()),
      enable_ipv6: Type.Optional(Type.Boolean()),
    }),
    isReadOnly: false,
    runtimeScopes: ["chat", "cron_auto_prompt"],
    execute: (toolCall) => {
      const args = asRecord(toolCall.arguments);
      return executeCrateBayCliTool(toolCall, "cratebay_engine_pod_create", {
        name: optionalString(args.name) ?? "",
        driver: optionalString(args.driver),
        internal: optionalBoolean(args.internal),
        enable_ipv6: optionalBoolean(args.enable_ipv6),
      });
    },
  },
  {
    id: "cratebay_engine_remove_pod",
    label: "CrateBay Native Remove Pod",
    name: "CrateBayNativeRemovePod",
    description: "Remove a pod through the native CrateBay Engine API.",
    parameters: Type.Object({
      name: Type.String(),
    }),
    isReadOnly: false,
    runtimeScopes: ["chat", "cron_auto_prompt"],
    execute: (toolCall) =>
      executeCrateBayCliTool(toolCall, "cratebay_engine_pod_remove", {
        name: optionalString(asRecord(toolCall.arguments).name) ?? "",
      }),
  },
  {
    id: "cratebay_engine_attach_pod",
    label: "CrateBay Native Attach Pod",
    name: "CrateBayNativeAttachPod",
    description: "Attach a container to a CrateBay-managed pod through the native CrateBay Engine API.",
    parameters: Type.Object({
      name: Type.String(),
      container: Type.String(),
    }),
    isReadOnly: false,
    runtimeScopes: ["chat", "cron_auto_prompt"],
    execute: (toolCall) => {
      const args = asRecord(toolCall.arguments);
      return executeCrateBayCliTool(toolCall, "cratebay_engine_pod_attach", {
        name: optionalString(args.name) ?? "",
        container: optionalString(args.container) ?? "",
      });
    },
  },
  {
    id: "cratebay_engine_detach_pod",
    label: "CrateBay Native Detach Pod",
    name: "CrateBayNativeDetachPod",
    description: "Detach a container from a CrateBay-managed pod through the native CrateBay Engine API.",
    parameters: Type.Object({
      name: Type.String(),
      container: Type.String(),
      force: Type.Optional(Type.Boolean()),
    }),
    isReadOnly: false,
    runtimeScopes: ["chat", "cron_auto_prompt"],
    execute: (toolCall) => {
      const args = asRecord(toolCall.arguments);
      return executeCrateBayCliTool(toolCall, "cratebay_engine_pod_detach", {
        name: optionalString(args.name) ?? "",
        container: optionalString(args.container) ?? "",
        force: optionalBoolean(args.force) ?? false,
      });
    },
  },
  {
    id: "cratebay_engine_create",
    label: "CrateBay Native Create",
    name: "CrateBayNativeCreate",
    description:
      "Create a container through the native CrateBay Engine API as a containerd-managed task with bind/volume mounts.",
    parameters: Type.Object({
      name: Type.String(),
      image: Type.String(),
      command: Type.Optional(Type.String()),
      entrypoint: Type.Optional(Type.String()),
      working_dir: Type.Optional(Type.String()),
      env: Type.Optional(Type.Array(Type.String())),
      publish: Type.Optional(Type.Array(Type.String())),
      volume: Type.Optional(Type.Array(Type.String())),
      pod: Type.Optional(Type.String()),
      network: Type.Optional(Type.String()),
      user: Type.Optional(Type.String()),
      read_only: Type.Optional(Type.Boolean()),
      no_start: Type.Optional(Type.Boolean()),
      cpu: Type.Optional(Type.Number()),
      memory: Type.Optional(Type.Number()),
    }),
    isReadOnly: false,
    runtimeScopes: ["chat", "cron_auto_prompt"],
    execute: (toolCall) =>
      executeCrateBayCliTool(toolCall, "cratebay_engine_container_create", {
        request: containerCreateRequest(asRecord(toolCall.arguments)),
      }),
  },
  {
    id: "cratebay_engine_start",
    label: "CrateBay Native Start",
    name: "CrateBayNativeStart",
    description: "Start a container through the native CrateBay Engine API.",
    parameters: Type.Object({
      id: Type.String(),
    }),
    isReadOnly: false,
    runtimeScopes: ["chat", "cron_auto_prompt"],
    execute: (toolCall) =>
      executeCrateBayCliTool(toolCall, "cratebay_engine_container_start", {
        id: optionalString(asRecord(toolCall.arguments).id) ?? "",
      }),
  },
  {
    id: "cratebay_engine_stop",
    label: "CrateBay Native Stop",
    name: "CrateBayNativeStop",
    description: "Stop a container through the native CrateBay Engine API.",
    parameters: Type.Object({
      id: Type.String(),
      timeout: Type.Optional(Type.Number()),
    }),
    isReadOnly: false,
    runtimeScopes: ["chat", "cron_auto_prompt"],
    execute: (toolCall) => {
      const args = asRecord(toolCall.arguments);
      return executeCrateBayCliTool(toolCall, "cratebay_engine_container_stop", {
        id: optionalString(args.id) ?? "",
        timeout: optionalNumber(args.timeout),
      });
    },
  },
  {
    id: "cratebay_engine_remove",
    label: "CrateBay Native Remove",
    name: "CrateBayNativeRemove",
    description: "Remove a container through the native CrateBay Engine API.",
    parameters: Type.Object({
      id: Type.String(),
      force: Type.Optional(Type.Boolean()),
    }),
    isReadOnly: false,
    runtimeScopes: ["chat", "cron_auto_prompt"],
    execute: (toolCall) => {
      const args = asRecord(toolCall.arguments);
      return executeCrateBayCliTool(toolCall, "cratebay_engine_container_remove", {
        id: optionalString(args.id) ?? "",
        force: optionalBoolean(args.force) ?? false,
      });
    },
  },
  {
    id: "cratebay_engine_inspect",
    label: "CrateBay Native Inspect",
    name: "CrateBayNativeInspect",
    description: "Inspect a container through the native CrateBay Engine API.",
    parameters: Type.Object({
      id: Type.String(),
    }),
    isReadOnly: true,
    runtimeScopes: ["chat", "cron_auto_prompt"],
    execute: (toolCall) =>
      executeCrateBayCliTool(toolCall, "cratebay_engine_container_inspect", {
        id: optionalString(asRecord(toolCall.arguments).id) ?? "",
      }),
  },
  {
    id: "cratebay_engine_stats",
    label: "CrateBay Native Stats",
    name: "CrateBayNativeStats",
    description: "Read CPU and memory stats through the native CrateBay Engine API.",
    parameters: Type.Object({
      id: Type.String(),
    }),
    isReadOnly: true,
    runtimeScopes: ["chat", "cron_auto_prompt"],
    execute: (toolCall) =>
      executeCrateBayCliTool(toolCall, "cratebay_engine_container_stats", {
        id: optionalString(asRecord(toolCall.arguments).id) ?? "",
      }),
  },
  {
    id: "cratebay_engine_logs",
    label: "CrateBay Native Logs",
    name: "CrateBayNativeLogs",
    description: "Read container logs through the native CrateBay Engine API.",
    parameters: Type.Object({
      id: Type.String(),
      tail: Type.Optional(Type.Number()),
      timestamps: Type.Optional(Type.Boolean()),
    }),
    isReadOnly: true,
    runtimeScopes: ["chat", "cron_auto_prompt"],
    execute: (toolCall) => {
      const args = asRecord(toolCall.arguments);
      return executeCrateBayCliTool(toolCall, "cratebay_engine_container_logs", {
        request: {
          id: optionalString(args.id) ?? "",
          tail: optionalNumber(args.tail),
          timestamps: optionalBoolean(args.timestamps),
        },
      });
    },
  },
  {
    id: "cratebay_engine_exec",
    label: "CrateBay Native Exec",
    name: "CrateBayNativeExec",
    description: "Execute a command through the native CrateBay Engine API using containerd for CrateBay-managed tasks.",
    parameters: Type.Object({
      id: Type.String(),
      command: Type.Array(Type.String()),
      working_dir: Type.Optional(Type.String()),
      timeout: Type.Optional(Type.Number()),
      max_output_bytes: Type.Optional(Type.Number()),
    }),
    isReadOnly: false,
    runtimeScopes: ["chat", "cron_auto_prompt"],
    execute: (toolCall) => {
      const args = asRecord(toolCall.arguments);
      return executeCrateBayCliTool(toolCall, "cratebay_engine_container_exec", {
        request: {
          id: optionalString(args.id) ?? "",
          command: optionalStringArray(args.command) ?? [],
          workingDir: optionalString(args.working_dir),
          timeout: optionalNumber(args.timeout),
          maxOutputBytes: optionalNumber(args.max_output_bytes),
        },
      });
    },
  },
  {
    id: "cratebay_engine_terminal_open",
    label: "CrateBay Native Terminal Open",
    name: "CrateBayNativeTerminalOpen",
    description: "Open a native CrateBay Engine PTY terminal session in a running container.",
    parameters: Type.Object({
      id: Type.String(),
      session_id: Type.Optional(Type.String()),
      working_dir: Type.Optional(Type.String()),
      cols: Type.Optional(Type.Number()),
      rows: Type.Optional(Type.Number()),
      command: Type.Optional(Type.Array(Type.String())),
    }),
    isReadOnly: false,
    runtimeScopes: ["chat"],
    execute: (toolCall) =>
      executeCrateBayCliTool(toolCall, "cratebay_engine_terminal_open", {
        request: terminalOpenRequest(asRecord(toolCall.arguments)),
      }),
  },
  {
    id: "cratebay_engine_terminal_input",
    label: "CrateBay Native Terminal Input",
    name: "CrateBayNativeTerminalInput",
    description: "Send input to a native CrateBay Engine PTY terminal session.",
    parameters: Type.Object({
      id: Type.String(),
      session_id: Type.String(),
      data: Type.String(),
    }),
    isReadOnly: false,
    runtimeScopes: ["chat"],
    execute: (toolCall) => {
      const args = asRecord(toolCall.arguments);
      return executeCrateBayCliTool(toolCall, "cratebay_engine_terminal_input", {
        request: {
          ...terminalSessionRequest(args),
          data: stringValue(args.data),
        },
      });
    },
  },
  {
    id: "cratebay_engine_terminal_read",
    label: "CrateBay Native Terminal Read",
    name: "CrateBayNativeTerminalRead",
    description: "Read pending output from a native CrateBay Engine PTY terminal session.",
    parameters: Type.Object({
      id: Type.String(),
      session_id: Type.String(),
    }),
    isReadOnly: true,
    runtimeScopes: ["chat"],
    execute: (toolCall) =>
      executeCrateBayCliTool(toolCall, "cratebay_engine_terminal_read", {
        request: terminalSessionRequest(asRecord(toolCall.arguments)),
      }),
  },
  {
    id: "cratebay_engine_terminal_resize",
    label: "CrateBay Native Terminal Resize",
    name: "CrateBayNativeTerminalResize",
    description: "Resize a native CrateBay Engine PTY terminal session.",
    parameters: Type.Object({
      id: Type.String(),
      session_id: Type.String(),
      cols: Type.Number(),
      rows: Type.Number(),
    }),
    isReadOnly: false,
    runtimeScopes: ["chat"],
    execute: (toolCall) => {
      const args = asRecord(toolCall.arguments);
      return executeCrateBayCliTool(toolCall, "cratebay_engine_terminal_resize", {
        request: {
          ...terminalSessionRequest(args),
          cols: optionalNumber(args.cols) ?? 80,
          rows: optionalNumber(args.rows) ?? 24,
        },
      });
    },
  },
  {
    id: "cratebay_engine_terminal_close",
    label: "CrateBay Native Terminal Close",
    name: "CrateBayNativeTerminalClose",
    description: "Close a native CrateBay Engine PTY terminal session.",
    parameters: Type.Object({
      id: Type.String(),
      session_id: Type.String(),
    }),
    isReadOnly: false,
    runtimeScopes: ["chat"],
    execute: (toolCall) =>
      executeCrateBayCliTool(toolCall, "cratebay_engine_terminal_close", {
        request: terminalSessionRequest(asRecord(toolCall.arguments)),
      }),
  },
] as const satisfies readonly SystemToolDefinition[];

export type SystemToolId = (typeof SELECTABLE_SYSTEM_TOOL_DEFINITIONS)[number]["id"];

export const CRATEBAY_SYSTEM_TOOL_IDS = SELECTABLE_SYSTEM_TOOL_DEFINITIONS.filter((tool) =>
  tool.id.startsWith("cratebay_"),
).map((tool) => tool.id) as SystemToolId[];

export const CUSTOM_SYSTEM_TOOL_OPTIONS: Array<{
  id: SystemToolId;
  label: string;
  description: string;
}> = SELECTABLE_SYSTEM_TOOL_DEFINITIONS.map(({ id, label, description }) => ({
  id,
  label,
  description,
}));

function supportsRuntimeScope(
  definition: SystemToolDefinition,
  runtimeScope: SystemToolRuntimeScope,
) {
  return definition.runtimeScopes.includes(runtimeScope);
}

export function createCustomSystemTools(params: {
  selectedToolIds: SystemToolId[];
  runtimeScope: SystemToolRuntimeScope;
  currentChatModel?: {
    customProviderId: string;
    model: string;
  };
}): BuiltinToolBundle {
  const selected = new Set<SystemToolId>(params.selectedToolIds);
  const activeDefinitions = SELECTABLE_SYSTEM_TOOL_DEFINITIONS.filter(
    (definition) =>
      selected.has(definition.id) && supportsRuntimeScope(definition, params.runtimeScope),
  );
  const activeDefinitionByName = new Map<string, SystemToolDefinition>(
    activeDefinitions.map((definition) => [definition.name, definition]),
  );
  const tools: Tool[] = activeDefinitions.map(({ name, description, parameters }) => ({
    name,
    description,
    parameters,
  }));

  async function executeToolCall(
    toolCall: ToolCall,
    signal?: AbortSignal,
  ): Promise<ToolResultMessage> {
    const now = Date.now();

    if (signal?.aborted) {
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: "Cancelled" }],
        details: {},
        isError: true,
        timestamp: now,
      };
    }

    const toolDefinition = activeDefinitionByName.get(toolCall.name);
    if (toolDefinition) {
      return toolDefinition.execute(toolCall, signal);
    }

    return {
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: [{ type: "text", text: `Unknown tool: ${toolCall.name}` }],
      details: {},
      isError: true,
      timestamp: now,
    };
  }

  return {
    groupId: "system",
    tools,
    executeToolCall,
    metadataByName: createBuiltinMetadataMap(
      activeDefinitions.map(({ id, name, isReadOnly }) => [
        name,
        {
          groupId: "system" as const,
          kind: id,
          isReadOnly,
          displayCategory: "system" as const,
        },
      ]),
    ),
  };
}
