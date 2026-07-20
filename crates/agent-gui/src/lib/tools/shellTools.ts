import type { Tool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { invoke } from "@tauri-apps/api/core";
import { Type } from "typebox";
import {
  inferRuntimePlatform,
  normalizeRuntimePlatform,
  type RuntimePlatform,
  runtimePlatformLabel,
} from "../runtimePlatform";
import type { ProviderId } from "../settings";
import { createUuid } from "../shared/id";
import {
  type BashTimeoutPolicy,
  GLOBAL_BASH_MAX_TIMEOUT_MS,
  MIN_BASH_TIMEOUT_MS,
  normalizeBashTimeoutMs,
  resolveBashTimeoutPolicy,
} from "./bashTimeoutPolicy";
import { type BuiltinToolBundle, createBuiltinMetadataMap } from "./builtinTypes";
import { formatResolvedTarget, type ResolvedPath, ToolPathResolver } from "./pathUtils";
import { assertSkillPathAllowedByPolicy, type SkillAccessPolicy } from "./skillAccessPolicy";

type ShellRunResponse = {
  exit_code: number;
  shell: string;
  platform?: string;
  profile?: string;
  shell_family?: string;
  stdout: string;
  stderr: string;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  timed_out: boolean;
  cancelled: boolean;
  stdio_open_after_exit?: boolean;
  effective_timeout_ms: number;
  duration_ms: number;
};

type ShellCancelResponse = {
  cancelled: boolean;
};

type ManagedProcessRecord = {
  id: string;
  label?: string | null;
  command: string;
  cwd: string;
  shell: string;
  pid: number;
  log_path: string;
  started_at: number;
  finished_at?: number | null;
  exit_code?: number | null;
  running: boolean;
  isolated?: boolean;
  restored?: boolean;
};

type ManagedProcessStartResponse = {
  process: ManagedProcessRecord;
};

type ManagedProcessStatusResponse = {
  processes: ManagedProcessRecord[];
};

type ManagedProcessStopResponse = {
  stopped: boolean;
  process?: ManagedProcessRecord | null;
};

type ManagedProcessLogResponse = {
  id: string;
  log_path: string;
  content: string;
  truncated: boolean;
  bytes: number;
};

type SystemListSkillFilesResponse = {
  rootDir?: string | null;
};

function asErrorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

function createShellRunId(toolCallId: string) {
  return `bash-${toolCallId || "tool"}-${createUuid()}`;
}

function delay(ms: number) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

function strictToolParameters(properties: Record<string, unknown>) {
  return Type.Object(properties as any, { additionalProperties: false });
}

function assertKnownArguments(toolName: string, args: unknown, allowed: readonly string[]) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return;
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(args).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw new Error(
      `${toolName} received unsupported argument${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`,
    );
  }
}

function requestShellCancel(runId: string) {
  void (async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const response = await invoke<ShellCancelResponse>("shell_cancel", {
          run_id: runId,
        } as any);
        if (response.cancelled) return;
      } catch {
        return;
      }
      await delay(50);
    }
  })();
}

type ShellSyntaxScan = {
  background: boolean;
  unsafeBackground: boolean;
  stdoutRedirect: boolean;
  stderrRedirect: boolean;
};

function scanShellSyntax(command: string): ShellSyntaxScan {
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;
  let currentStdoutRedirect = false;
  let currentStderrRedirect = false;
  const result: ShellSyntaxScan = {
    background: false,
    unsafeBackground: false,
    stdoutRedirect: false,
    stderrRedirect: false,
  };

  const resetCommandSegment = () => {
    currentStdoutRedirect = false;
    currentStderrRedirect = false;
  };
  const markStdoutRedirect = () => {
    currentStdoutRedirect = true;
    result.stdoutRedirect = true;
  };
  const markStderrRedirect = () => {
    currentStderrRedirect = true;
    result.stderrRedirect = true;
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];

    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\" && quote !== "'") {
        escaped = true;
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      continue;
    }

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }

    if (ch === "#") {
      while (i + 1 < command.length && command[i + 1] !== "\n") {
        i += 1;
      }
      continue;
    }

    if (ch === ";" || ch === "\n") {
      resetCommandSegment();
      continue;
    }

    if (ch === "&") {
      const prev = command[i - 1] ?? "";
      const next = command[i + 1] ?? "";
      if (next === "&") {
        resetCommandSegment();
        i += 1;
        continue;
      }
      if (next === ">") {
        markStdoutRedirect();
        markStderrRedirect();
        i += 1;
        continue;
      }
      if (prev === ">") {
        continue;
      }
      result.background = true;
      if (!currentStdoutRedirect || !currentStderrRedirect) {
        result.unsafeBackground = true;
      }
      resetCommandSegment();
      continue;
    }

    if (ch === "|" && command[i + 1] === "|") {
      resetCommandSegment();
      i += 1;
      continue;
    }

    if (ch === ">") {
      const prev = command[i - 1] ?? "";
      if (prev === ">") {
        continue;
      }
      if (prev === "2") {
        markStderrRedirect();
      } else {
        markStdoutRedirect();
      }
    }
  }

  return result;
}

function validateBashBackgroundStdio(command: string) {
  const syntax = scanShellSyntax(command);
  if (!syntax.background) return;
  if (!syntax.unsafeBackground) return;

  throw new Error(
    [
      "Background Bash commands must detach stdout and stderr before using `&`.",
      "Long-running processes that inherit LiveAgent's tool pipes can keep the Bash task running forever.",
      "Redirect output to a log file, for example: `nohup command > /tmp/liveagent-task.log 2>&1 < /dev/null &`.",
      "For dev servers or watchers, prefer a dedicated terminal or managed process workflow.",
    ].join(" "),
  );
}

function normalizeProcessAction(input: unknown) {
  const action = typeof input === "string" ? input.trim().toLowerCase() : "";
  if (action === "start" || action === "status" || action === "read_log" || action === "stop") {
    return action;
  }
  throw new Error("ManagedProcess.action must be one of: start, status, read_log, stop");
}

function formatManagedProcessRecord(process: ManagedProcessRecord) {
  return [
    `id=${process.id}`,
    process.label ? `label=${process.label}` : null,
    `running=${process.running}`,
    `isolated=${process.isolated === true}`,
    `pid=${process.pid}`,
    `shell=${process.shell}`,
    `cwd=${process.cwd}`,
    `log=${process.log_path}`,
    process.exit_code !== null && process.exit_code !== undefined
      ? `exit_code=${process.exit_code}`
      : null,
    `command=${process.command}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildManagedProcessToolResult(params: {
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

function buildCancelledResult(params: {
  toolCall: ToolCall;
  command?: string;
  cwd?: string;
  startedAt: number;
  effectiveTimeoutMs?: number;
  shell?: string;
  runtimePlatform?: RuntimePlatform;
  timeoutPolicy: BashTimeoutPolicy;
}): ToolResultMessage {
  const durationMs = Date.now() - params.startedAt;
  const details: ShellRunResponse = {
    exit_code: -1,
    shell: params.shell || "unknown",
    platform: params.runtimePlatform,
    profile: params.runtimePlatform === "windows" ? "windows-pwsh" : undefined,
    shell_family: params.runtimePlatform
      ? params.runtimePlatform === "windows"
        ? "powershell"
        : "posix"
      : undefined,
    stdout: "",
    stderr: "Cancelled",
    stdout_truncated: false,
    stderr_truncated: false,
    timed_out: false,
    cancelled: true,
    effective_timeout_ms: params.effectiveTimeoutMs ?? params.timeoutPolicy.defaultTimeoutMs,
    duration_ms: durationMs,
  };
  const header = [
    "# Shell",
    `shell: ${details.shell}`,
    details.platform ? `platform: ${details.platform}` : null,
    details.profile ? `profile: ${details.profile}` : null,
    details.shell_family ? `shell_family: ${details.shell_family}` : null,
    params.cwd ? `cwd: ${params.cwd}` : null,
    "exit_code: -1",
    "cancelled: true",
    `timeout_ms: ${details.effective_timeout_ms}`,
    `duration_ms: ${durationMs}`,
  ]
    .filter(Boolean)
    .join("\n");
  const body = ["", "command:", params.command || "", "", "stderr:", "Cancelled"].join("\n");
  return {
    role: "toolResult",
    toolCallId: params.toolCall.id,
    toolName: params.toolCall.name,
    content: [{ type: "text", text: `${header}\n${body}` }],
    details,
    isError: true,
    timestamp: params.startedAt,
  };
}

export function createShellTools(params: {
  workdir: string;
  providerId: ProviderId;
  runtimePlatform?: RuntimePlatform;
  skillsRootEnabled?: boolean;
  skillsRootDir?: string;
  skillAccessPolicy?: SkillAccessPolicy;
  managedProcessEnabled?: boolean;
  /** false 时 Bash/ManagedProcess 的 cwd 锁定在工作区与已启用 Skills 内。 */
  externalCwdAllowed?: boolean;
  resolveHomeDir?: () => Promise<string>;
}): BuiltinToolBundle {
  const timeoutPolicy = resolveBashTimeoutPolicy(params.providerId);
  const runtimePlatform =
    normalizeRuntimePlatform(params.runtimePlatform) ?? inferRuntimePlatform();
  const platformLabel = runtimePlatformLabel(runtimePlatform);
  const shellPolicy =
    runtimePlatform === "windows"
      ? 'Windows runs Bash commands with the native Windows shell chain: pwsh first, then Windows PowerShell, then cmd. Use PowerShell syntax by default: `Write-Output`, `$env:NAME = "value"`, semicolon separators, and `Start-Process` when a process must be detached. Do not assume Git Bash, `export`, `nohup`, `/dev/null`, or POSIX background syntax.'
      : runtimePlatform === "macos"
        ? "macOS runs Bash commands with POSIX shell syntax: zsh first, then Bash, then sh."
        : "Linux runs Bash commands with POSIX shell syntax: Bash first, then zsh, then sh.";
  const backgroundPolicy =
    runtimePlatform === "windows"
      ? "For dev servers, watchers, or long-running commands on Windows, use ManagedProcess instead of detached shell syntax."
      : "Background commands using `&` must detach stdout and stderr first, for example `nohup command > /tmp/liveagent-task.log 2>&1 < /dev/null &`; otherwise the tool rejects them because inherited pipes can keep Bash running forever.";
  const workdir = params.workdir;
  const allowSkillsRoot = params.skillsRootEnabled === true;
  const allowManagedProcess = params.managedProcessEnabled !== false;
  const externalCwdAllowed = params.externalCwdAllowed !== false;

  // workspace-only 模式下的越界报错补上设置来源，避免模型误以为是路径拼写问题。
  function appendCwdPolicyHint(message: string) {
    if (externalCwdAllowed) return message;
    if (!/outside the workspace/i.test(message)) return message;
    return `${message} Bash cwd is locked to the workspace by settings (Bash working directory: workspace only); run the command inside the workspace instead.`;
  }
  const skillAccessPolicy = params.skillAccessPolicy;
  let cachedSkillsRootDir =
    typeof params.skillsRootDir === "string" ? params.skillsRootDir.trim() : "";

  async function resolveSkillsRootDir() {
    if (!allowSkillsRoot) {
      throw new Error("Skill paths are only available when Skills are enabled");
    }
    if (cachedSkillsRootDir) return cachedSkillsRootDir;
    const response = await invoke<SystemListSkillFilesResponse>("system_list_skill_files");
    const rootDir = typeof response.rootDir === "string" ? response.rootDir.trim() : "";
    if (!rootDir) {
      throw new Error("Skills root is unavailable; refresh Skills discovery and retry.");
    }
    cachedSkillsRootDir = rootDir;
    return cachedSkillsRootDir;
  }

  const pathResolver = new ToolPathResolver({
    workdir,
    resolveHomeDir: params.resolveHomeDir,
    skillsRootEnabled: allowSkillsRoot,
    skillsRootDir: cachedSkillsRootDir,
    skillAccessPolicy,
    resolveSkillsRootDir,
  });

  function backendCwd(resolved: ResolvedPath) {
    return resolved.scope === "workspace"
      ? resolved.relativePath || undefined
      : resolved.absolutePath;
  }

  function normalizeCommandForPolicy(command: string) {
    return command.replace(/\\/g, "/");
  }

  function commandReferencesFixedSkillsRoot(command: string) {
    const value = normalizeCommandForPolicy(command);
    if (/(\.liveagent\/skills|~\/\.liveagent\/skills)/i.test(value)) return true;
    const root = cachedSkillsRootDir.trim().replace(/\\/g, "/");
    return Boolean(root && value.includes(root));
  }

  // True when the command's leading file-read/search verb (cat/ls/grep/...) is
  // pointed directly at an absolute Skills path — these should always be routed
  // to Read / List / Glob / Grep instead of Bash.
  function commandFileReadVerbAgainstSkillsAbsolute(command: string) {
    const value = normalizeCommandForPolicy(command);
    if (!commandReferencesFixedSkillsRoot(value)) return false;
    const root = cachedSkillsRootDir.trim().replace(/\\/g, "/");
    const escapedRoot = root ? root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : null;
    const skillPathPrefix = escapedRoot
      ? `(?:~/\\.liveagent/skills|/\\.liveagent/skills|${escapedRoot})`
      : "(?:~/\\.liveagent/skills|/\\.liveagent/skills)";
    const fileReadPattern = new RegExp(
      `(?:^|[\\s;&|()])(?:cat|head|tail|less|more|ls|find|grep|fgrep|egrep|rg|sed|awk)\\b(?:\\s+-[A-Za-z0-9_-]+)*\\s+['"]?${skillPathPrefix}`,
      "i",
    );
    return fileReadPattern.test(value);
  }

  function commandChangesDirectoryToSkillsAbsolute(command: string) {
    const value = normalizeCommandForPolicy(command);
    if (!commandReferencesFixedSkillsRoot(value)) return false;
    const root = cachedSkillsRootDir.trim().replace(/\\/g, "/");
    const escapedRoot = root ? root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : null;
    const skillPathPrefix = escapedRoot
      ? `(?:~/\\.liveagent/skills|/\\.liveagent/skills|${escapedRoot})`
      : "(?:~/\\.liveagent/skills|/\\.liveagent/skills)";
    const cdPattern = new RegExp(
      `(?:^|[\\s;&|()])(?:cd|pushd)\\b\\s+(?:--\\s+)?['"]?${skillPathPrefix}(?:[/\\s'";&|)]|$)`,
      "i",
    );
    return cdPattern.test(value);
  }

  // Extract the Skill base-dir names referenced via absolute paths in the
  // command. Each match captures the first segment after the Skills root.
  function extractSkillBaseDirsFromAbsolutePath(command: string): string[] {
    const value = normalizeCommandForPolicy(command);
    const names = new Set<string>();
    const segmentChars = "[A-Za-z0-9._-]+";
    const patterns: RegExp[] = [
      new RegExp(`~/\\.liveagent/skills/(${segmentChars})`, "gi"),
      new RegExp(`(?:^|[\\s;&|(])/\\.liveagent/skills/(${segmentChars})`, "gi"),
    ];
    for (const re of patterns) {
      for (const match of value.matchAll(re)) names.add(match[1]);
    }
    const root = cachedSkillsRootDir.trim().replace(/\\/g, "/");
    if (root) {
      const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`${escaped}/(${segmentChars})`, "gi");
      for (const match of value.matchAll(re)) names.add(match[1]);
    }
    return Array.from(names);
  }

  function commandUsesWorkspaceSkillsGuess(command: string) {
    return /(^|[\s;&|()])(?:cd|pushd|python3?|node|bash|sh|zsh)\s+["']?\.?\/?skills\/[^ \n;&|)]+/i.test(
      normalizeCommandForPolicy(command),
    );
  }

  function commandSearchesFilesystemForSkills(command: string) {
    return /\bfind\s+\/(?:\s|$)[\s\S]*(skills|\.liveagent|SKILL\.md|skill\.json|README\.md)/i.test(
      normalizeCommandForPolicy(command),
    );
  }

  function commandEscapesScopedSkillsCwd(command: string) {
    return /(^|[\s;&|()])cd\s+\.\.(?:[\s;&|)]|\/|$)|\.\.\//.test(
      normalizeCommandForPolicy(command),
    );
  }

  function validateBashSkillAccess(params: { cwd: ResolvedPath; command: string }) {
    if (params.cwd.scope === "skill") {
      if (commandReferencesFixedSkillsRoot(params.command)) {
        throw new Error(
          "Bash with a Skill cwd must use paths relative to that cwd. Do not cd into or execute absolute ~/.liveagent/skills paths.",
        );
      }
      if (commandSearchesFilesystemForSkills(params.command)) {
        throw new Error(
          "Bash with a Skill cwd cannot run find / to discover Skill files. Use List/Glob/Grep inside the enabled Skill path.",
        );
      }
      if (commandEscapesScopedSkillsCwd(params.command)) {
        throw new Error(
          "Bash with a Skill cwd cannot use .. or cd .. to move outside the enabled Skill directory.",
        );
      }
      return;
    }

    if (commandReferencesFixedSkillsRoot(params.command)) {
      // Route file-read verbs (cat/ls/grep/...) against absolute Skill paths
      // back to the dedicated file tools — they offer caching, version metadata,
      // and Skill-aware access policy that raw Bash cannot match.
      if (commandFileReadVerbAgainstSkillsAbsolute(params.command)) {
        throw new Error(
          "Bash cannot read or search ~/.liveagent/skills or absolute Skill paths. Use Read/List/Glob/Grep with a skill://<enabled-skill>/... path instead of cat, head, tail, ls, find, grep, rg, sed, or awk.",
        );
      }
      if (commandChangesDirectoryToSkillsAbsolute(params.command)) {
        throw new Error(
          "Bash cannot cd into the fixed Skills root. To run an installed Skill script, set cwd to skill://<enabled-skill>/scripts and use a relative command, or execute the absolute script path directly when that Skill is enabled.",
        );
      }
      // Otherwise (directly executing scripts, etc.) treat absolute Skill paths
      // as supported input. The substantive security boundary is the per-Skill
      // access policy: every referenced Skill must be enabled in this conversation.
      const referencedSkills = extractSkillBaseDirsFromAbsolutePath(params.command);
      if (referencedSkills.length === 0) {
        throw new Error(
          "Bash references the ~/.liveagent/skills root without naming a specific installed Skill. Include a Skill name such as ~/.liveagent/skills/<skill-name>/... or set cwd to skill://<enabled-skill>/scripts.",
        );
      }
      for (const baseDir of referencedSkills) {
        assertSkillPathAllowedByPolicy(skillAccessPolicy, `${baseDir}/`, "Bash");
      }
      // All referenced Skills are enabled — allow the absolute path through.
    }
    if (commandUsesWorkspaceSkillsGuess(params.command)) {
      throw new Error(
        "Bash cannot cd into workspace skills/ guesses. Enable the installed Skill, then set cwd to skill://<enabled-skill>/scripts.",
      );
    }
    if (commandSearchesFilesystemForSkills(params.command)) {
      throw new Error(
        "Bash cannot run find / to discover installed Skills. Use enabled Skills via SkillsManager and scoped file tools instead.",
      );
    }
  }

  function buildShellFailureHint(params: {
    cwd: ResolvedPath;
    command: string;
    stdout: string;
    stderr: string;
  }) {
    const combined = [params.command, params.stdout, params.stderr].join("\n");
    const hints: string[] = [];

    if (
      runtimePlatform === "windows" &&
      /(^|[\s;&|])(?:export|nohup)\b|\/dev\/null|not recognized as|不是内部或外部命令|无法将.*识别为/i.test(
        combined,
      )
    ) {
      hints.push(
        'Hint: This Bash tool is running with Windows-native shells. Use PowerShell syntax such as `Write-Output`, `$env:NAME = "value"`, and `;`, or use ManagedProcess for long-running commands.',
      );
    }

    if (
      params.cwd.scope !== "skill" &&
      /(\.liveagent\/skills|~\/\.liveagent\/skills|\bskills\/[^ \n;&|]+\/scripts\b)/.test(combined)
    ) {
      hints.push(
        "Hint: To run a Skill script, set cwd to skill://<enabled-skill>/scripts and use a relative command, or execute the absolute script path directly when the Skill is enabled.",
      );
    }

    if (
      /(cat|ls|find|grep|rg|sed)\b/.test(params.command) &&
      /(\.liveagent\/skills|~\/\.liveagent\/skills|skills\/)/.test(params.command)
    ) {
      hints.push(
        "Hint: If you are reading, listing, or searching Skill files, use Read/List/Glob/Grep with skill://<enabled-skill>/... paths instead of Bash.",
      );
    }

    if (
      params.cwd.scope === "skill" &&
      /No such file or directory|can't open file|not found|没有那个文件|无法打开文件/i.test(
        combined,
      )
    ) {
      hints.push(
        "Hint: Use List/Glob with the same skill:// path to locate the script or file, then retry Bash with that Skill cwd.",
      );
    }

    if (
      /(no such table|unable to open database file|ModuleNotFoundError|ImportError|Missing content|ValueError)/i.test(
        combined,
      )
    ) {
      hints.push(
        "Hint: This is an application or script error rather than a path normalization error. Inspect the script help or source with Read, then retry with the required arguments or dependency setup.",
      );
    }

    return hints.length > 0 ? `\n\n${Array.from(new Set(hints)).join("\n")}` : "";
  }

  const toolBash: Tool = {
    name: "Bash",
    description: `Execute a non-interactive shell command on the local machine for builds, tests, package managers, external CLIs, curl/API calls, running Skill scripts, or explicitly requested shell work. Runtime platform: ${platformLabel}. ${shellPolicy} Reserve it for commands that truly require a shell — do NOT use Bash for file operations the dedicated tools handle: use Read/List/Glob/Grep instead of cat/ls/find/grep/rg for any workspace or Skill content; use Delete instead of rm/rmdir/unlink/find -delete; use Image instead of open/xdg-open/file paths to show pictures. Use curl with an explicit timeout such as \`--max-time 30\` for endpoint tests. ${backgroundPolicy} Running a Skill script: set cwd to \`skill://<enabled-skill>/scripts\` and run a relative command, or execute the absolute script path directly when that Skill is enabled. Use / as the path separator; Windows \\ is auto-normalized. Returns stdout, stderr, exit_code, platform, profile, and shell_family. For ${timeoutPolicy.providerLabel}, timeout defaults to ${timeoutPolicy.defaultTimeoutMs}ms and is capped at ${timeoutPolicy.maxTimeoutMs}ms; larger timeout_ms values are accepted by the schema but clamped before execution. High risk: use carefully.`,
    parameters: strictToolParameters({
      command: Type.String({
        description: "Shell command to execute (prefer non-interactive, idempotent commands).",
      }),
      cwd: Type.Optional(
        Type.String({
          description:
            "Optional working directory. Omit to use the workspace root. Prefer the workspace-relative or skill:// form returned by other tools; may also be an absolute path outside the workspace.",
        }),
      ),
      timeout_ms: Type.Optional(
        Type.Number({
          minimum: MIN_BASH_TIMEOUT_MS,
          maximum: GLOBAL_BASH_MAX_TIMEOUT_MS,
          description: `Timeout in milliseconds (default: ${timeoutPolicy.defaultTimeoutMs}, provider cap: ${timeoutPolicy.maxTimeoutMs}; larger values are clamped before execution).`,
        }),
      ),
    }),
  };

  const toolManagedProcess: Tool = {
    name: "ManagedProcess",
    description: `Start, inspect, read logs for, or stop a long-running local process such as a dev server, watcher, or preview server. Runtime platform: ${platformLabel}; commands use the same platform shell policy as Bash. Use this instead of detached shell/background syntax. action="start" runs a foreground command under LiveAgent process management, redirects stdout/stderr to a log file, and returns immediately with process_id, pid, and log_path. By default managed processes are terminated automatically when LiveAgent exits; pass isolated=true only when the user explicitly wants the service to outlive LiveAgent. Use action="status" to list or inspect processes, action="read_log" to read recent log output, and action="stop" to terminate the process tree.`,
    parameters: strictToolParameters({
      action: Type.Union(
        [
          Type.Literal("start"),
          Type.Literal("status"),
          Type.Literal("read_log"),
          Type.Literal("stop"),
        ],
        {
          description: "Process action to run.",
        },
      ),
      command: Type.Optional(
        Type.String({
          description:
            'Required for action="start". Foreground command to run. Do not append `&`; ManagedProcess handles background lifecycle and log redirection.',
        }),
      ),
      cwd: Type.Optional(
        Type.String({
          description:
            'Optional working directory for action="start". Omit to use the workspace root. Prefer the workspace-relative or skill:// form returned by other tools; may also be an absolute path outside the workspace.',
        }),
      ),
      label: Type.Optional(
        Type.String({
          description:
            'Optional human-readable label for action="start", such as "survival-agent dev server".',
        }),
      ),
      isolated: Type.Optional(
        Type.Boolean({
          description:
            'Only for action="start". Default false: the process is terminated automatically when LiveAgent exits. Set true ONLY when the user explicitly asks for the service to keep running after LiveAgent quits; it then detaches from the LiveAgent lifecycle and must be stopped manually from the background tasks panel.',
        }),
      ),
      process_id: Type.Optional(
        Type.String({
          description:
            'Required for action="read_log" and action="stop"; optional filter for action="status".',
        }),
      ),
      max_bytes: Type.Optional(
        Type.Number({
          minimum: 1,
          maximum: 512 * 1024,
          description:
            'Maximum recent log bytes to return for action="read_log" (default 65536, maximum 524288).',
        }),
      ),
    }),
  };

  const tools: Tool[] = allowManagedProcess ? [toolBash, toolManagedProcess] : [toolBash];
  const allowedArgumentsByToolName: Record<string, readonly string[]> = {
    Bash: ["command", "cwd", "timeout_ms"],
    ManagedProcess: ["action", "command", "cwd", "label", "isolated", "process_id", "max_bytes"],
  };

  async function executeManagedProcessToolCall(
    toolCall: ToolCall,
    signal?: AbortSignal,
  ): Promise<ToolResultMessage> {
    const now = Date.now();
    try {
      assertKnownArguments(
        "ManagedProcess",
        toolCall.arguments,
        allowedArgumentsByToolName.ManagedProcess,
      );
    } catch (err) {
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: asErrorMessage(err) }],
        details: {},
        isError: true,
        timestamp: now,
      };
    }
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
    if (!workdir.trim()) {
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [
          { type: "text", text: "Working directory is not configured; cannot manage processes." },
        ],
        details: {},
        isError: true,
        timestamp: now,
      };
    }

    try {
      const action = normalizeProcessAction(toolCall.arguments?.action);
      const processId =
        typeof toolCall.arguments?.process_id === "string"
          ? toolCall.arguments.process_id.trim()
          : "";

      if (action === "start") {
        const command =
          typeof toolCall.arguments?.command === "string" ? toolCall.arguments.command.trim() : "";
        if (!command) throw new Error('ManagedProcess.command is required for action="start"');
        if (runtimePlatform !== "windows" && scanShellSyntax(command).background) {
          throw new Error(
            "ManagedProcess.command must be a foreground command. Remove `&`; ManagedProcess starts it in the background and captures logs automatically.",
          );
        }
        const cwdResolved = await pathResolver.resolvePath(toolCall.arguments?.cwd, {
          label: "ManagedProcess.cwd",
          intent: "cwd",
          required: false,
          allowExternal: externalCwdAllowed,
        });
        const cwd = backendCwd(cwdResolved);
        const label =
          typeof toolCall.arguments?.label === "string"
            ? toolCall.arguments.label.trim()
            : undefined;
        const isolated = toolCall.arguments?.isolated === true;
        const response = await invoke<ManagedProcessStartResponse>("managed_process_start", {
          workdir,
          command,
          cwd: cwd || undefined,
          label: label || undefined,
          isolated: isolated || undefined,
        } as any);
        return buildManagedProcessToolResult({
          toolCall,
          details: response,
          text: [
            "ManagedProcess started",
            formatManagedProcessRecord(response.process),
            "",
            `Read logs with ManagedProcess(action="read_log", process_id="${response.process.id}")`,
            `Stop it with ManagedProcess(action="stop", process_id="${response.process.id}")`,
          ].join("\n"),
        });
      }

      if (action === "status") {
        const response = await invoke<ManagedProcessStatusResponse>("managed_process_status", {
          process_id: processId || undefined,
        } as any);
        const lines = [
          `ManagedProcess status count=${response.processes.length}`,
          ...response.processes.map((process) => `---\n${formatManagedProcessRecord(process)}`),
        ];
        return buildManagedProcessToolResult({
          toolCall,
          details: response,
          text: lines.join("\n"),
        });
      }

      if (!processId) {
        throw new Error(
          `ManagedProcess.process_id is required for action=${JSON.stringify(action)}`,
        );
      }

      if (action === "read_log") {
        const maxBytes =
          typeof toolCall.arguments?.max_bytes === "number"
            ? Math.floor(toolCall.arguments.max_bytes)
            : undefined;
        const response = await invoke<ManagedProcessLogResponse>("managed_process_read_log", {
          process_id: processId,
          max_bytes: maxBytes,
        } as any);
        return buildManagedProcessToolResult({
          toolCall,
          details: response,
          text: [
            `ManagedProcess log id=${response.id}`,
            `log=${response.log_path}`,
            `bytes=${response.bytes}${response.truncated ? " truncated=true" : ""}`,
            "",
            response.content || "(empty log)",
          ].join("\n"),
        });
      }

      const response = await invoke<ManagedProcessStopResponse>("managed_process_stop", {
        process_id: processId,
      } as any);
      return buildManagedProcessToolResult({
        toolCall,
        details: response,
        text: response.process
          ? [
              `ManagedProcess stopped=${response.stopped}`,
              formatManagedProcessRecord(response.process),
            ].join("\n")
          : `ManagedProcess stopped=false\nprocess_id=${processId}\nnot_found=true`,
        isError: !response.process,
      });
    } catch (err) {
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: asErrorMessage(err) }],
        details: {},
        isError: true,
        timestamp: now,
      };
    }
  }

  async function executeToolCall(
    toolCall: ToolCall,
    signal?: AbortSignal,
  ): Promise<ToolResultMessage> {
    const now = Date.now();

    if (toolCall.name === "ManagedProcess" && allowManagedProcess) {
      return executeManagedProcessToolCall(toolCall, signal);
    }

    if (toolCall.name !== "Bash") {
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

    if (!workdir.trim()) {
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [
          { type: "text", text: "Working directory is not configured; cannot run the shell tool." },
        ],
        details: {},
        isError: true,
        timestamp: now,
      };
    }

    try {
      assertKnownArguments("Bash", toolCall.arguments, allowedArgumentsByToolName.Bash);
    } catch (err) {
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: asErrorMessage(err) }],
        details: {},
        isError: true,
        timestamp: now,
      };
    }

    const command =
      typeof toolCall.arguments?.command === "string" ? toolCall.arguments.command.trim() : "";

    if (signal?.aborted) {
      return buildCancelledResult({
        toolCall,
        command,
        startedAt: now,
        runtimePlatform,
        timeoutPolicy,
      });
    }

    if (!command) {
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: "Bash.command is required" }],
        details: {},
        isError: true,
        timestamp: now,
      };
    }

    let cwdResolved: ResolvedPath;
    let cwd: string | undefined;
    try {
      cwdResolved = await pathResolver.resolvePath(toolCall.arguments?.cwd, {
        label: "Bash.cwd",
        intent: "cwd",
        required: false,
        allowExternal: externalCwdAllowed,
      });
      cwd = backendCwd(cwdResolved);
    } catch (err) {
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [
          {
            type: "text",
            text: appendCwdPolicyHint(asErrorMessage(err)),
          },
        ],
        details: {},
        isError: true,
        timestamp: now,
      };
    }

    try {
      validateBashSkillAccess({ cwd: cwdResolved, command });
    } catch (err) {
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: asErrorMessage(err) }],
        details: {},
        isError: true,
        timestamp: now,
      };
    }

    if (runtimePlatform !== "windows") {
      try {
        validateBashBackgroundStdio(command);
      } catch (err) {
        return {
          role: "toolResult",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: [{ type: "text", text: asErrorMessage(err) }],
          details: {},
          isError: true,
          timestamp: now,
        };
      }
    }

    const timeoutRaw = toolCall.arguments?.timeout_ms;
    const timeout_ms = normalizeBashTimeoutMs(timeoutRaw, timeoutPolicy);
    const run_id = createShellRunId(toolCall.id);
    const abortHandler = () => {
      requestShellCancel(run_id);
    };

    try {
      if (signal) {
        signal.addEventListener("abort", abortHandler, { once: true });
        if (signal.aborted) {
          abortHandler();
        }
      }
      const res = await invoke<ShellRunResponse>("shell_run", {
        workdir,
        command,
        cwd: cwd || undefined,
        timeout_ms,
        max_timeout_ms: timeoutPolicy.maxTimeoutMs,
        provider_id: params.providerId,
        run_id,
      } as any);

      const header = [
        `# Shell`,
        `shell: ${res.shell || "unknown"}`,
        res.platform ? `platform: ${res.platform}` : null,
        res.profile ? `profile: ${res.profile}` : null,
        res.shell_family ? `shell_family: ${res.shell_family}` : null,
        `cwd: ${formatResolvedTarget(cwdResolved)}`,
        `exit_code: ${res.exit_code}`,
        res.timed_out ? `timed_out: true` : null,
        res.cancelled ? `cancelled: true` : null,
        res.stdio_open_after_exit ? `stdio_open_after_exit: true` : null,
        `timeout_ms: ${res.effective_timeout_ms || timeout_ms || timeoutPolicy.defaultTimeoutMs}`,
        `duration_ms: ${res.duration_ms}`,
      ]
        .filter(Boolean)
        .join("\n");

      const stdoutLabel = res.stdout_truncated ? "stdout (truncated)" : "stdout";
      const stderrLabel = res.stderr_truncated ? "stderr (truncated)" : "stderr";

      const body = [
        "",
        "command:",
        command,
        "",
        `${stdoutLabel}:`,
        res.stdout || "",
        "",
        `${stderrLabel}:`,
        res.stderr || "",
      ].join("\n");
      const hint =
        res.exit_code !== 0 || res.timed_out || res.cancelled
          ? buildShellFailureHint({
              cwd: cwdResolved,
              command,
              stdout: res.stdout || "",
              stderr: res.stderr || "",
            })
          : "";

      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: `${header}\n${body}${hint}` }],
        details: res,
        isError:
          res.exit_code !== 0 ||
          Boolean(res.timed_out) ||
          Boolean(res.cancelled) ||
          Boolean(res.stdio_open_after_exit),
        timestamp: now,
      };
    } catch (err) {
      if (signal?.aborted) {
        return buildCancelledResult({
          toolCall,
          command,
          cwd: formatResolvedTarget(cwdResolved),
          startedAt: now,
          effectiveTimeoutMs: timeout_ms,
          runtimePlatform,
          timeoutPolicy,
        });
      }
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: asErrorMessage(err) }],
        details: {},
        isError: true,
        timestamp: now,
      };
    } finally {
      signal?.removeEventListener("abort", abortHandler);
    }
  }

  const metadataEntries: Parameters<typeof createBuiltinMetadataMap>[0] = [
    [
      "Bash",
      {
        groupId: "shell",
        kind: "bash",
        isReadOnly: false,
        displayCategory: "terminal",
      },
    ],
  ];

  if (allowManagedProcess) {
    metadataEntries.push([
      "ManagedProcess",
      {
        groupId: "shell",
        kind: "managed_process",
        isReadOnly: false,
        displayCategory: "terminal",
      },
    ]);
  }

  return {
    groupId: "shell",
    tools,
    executeToolCall,
    metadataByName: createBuiltinMetadataMap(metadataEntries),
  };
}
