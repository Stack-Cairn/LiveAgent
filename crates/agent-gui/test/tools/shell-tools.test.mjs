import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

function createBashCall(command = "echo ready") {
  return {
    type: "toolCall",
    id: "call-bash",
    name: "Bash",
    arguments: {
      command,
      timeout_ms: 1000,
    },
  };
}

test("Bash tool keeps one Bash entry and uses Git Bash-first policy for Claude Code", async () => {
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          calls.push({ command, args });
          assert.equal(command, "shell_run");
          return {
            exit_code: 0,
            shell: "bash",
            platform: "windows",
            profile: "windows-git-bash",
            shell_family: "posix",
            stdout: "ready\n",
            stderr: "",
            stdout_truncated: false,
            stderr_truncated: false,
            timed_out: false,
            cancelled: false,
            effective_timeout_ms: args.timeout_ms,
            duration_ms: 12,
          };
        },
      },
    },
  });

  const { createShellTools } = loader.loadModule("src/lib/tools/shellTools.ts");
  const bundle = createShellTools({
    workdir: "/repo",
    providerId: "claude_code",
    runtimePlatform: "windows",
  });

  assert.match(bundle.tools[0].description, /Windows runs Bash commands/);
  assert.match(bundle.tools[0].description, /Git Bash \(POSIX semantics\)/);
  assert.match(bundle.tools[0].description, /Write POSIX\/bash syntax by default/);
  assert.match(bundle.tools[0].description, /always use Delete for intentional workspace or Skill deletions/);
  assert.match(bundle.tools[0].description, /PowerShell Remove-Item\/cmd del, erase, or rd/);
  assert.match(bundle.tools[0].description, /only structured Delete calls make deletions visible in Edited Files/);
  const managedProcess = bundle.tools.find((tool) => tool.name === "ManagedProcess");
  assert.ok(managedProcess);
  assert.match(managedProcess.description, /never use it to intentionally delete workspace/);
  assert.match(managedProcess.description, /use Delete so LiveAgent can track the deletion/);
  assert.doesNotMatch(bundle.tools[0].description, /native Windows shell chain/);

  const result = await bundle.executeToolCall(createBashCall());

  assert.equal(result.isError, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.provider_id, "claude_code");
  assert.equal(calls[0].args.max_timeout_ms, 600_000);
  assert.match(result.content[0].text, /platform: windows/);
  assert.match(result.content[0].text, /profile: windows-git-bash/);
});

test("Bash tool uses the same Git Bash-first policy for Codex", async () => {
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          calls.push({ command, args });
          assert.equal(command, "shell_run");
          return {
            exit_code: 0,
            shell: "bash",
            platform: "windows",
            profile: "windows-git-bash",
            shell_family: "posix",
            stdout: "ready\n",
            stderr: "",
            stdout_truncated: false,
            stderr_truncated: false,
            timed_out: false,
            cancelled: false,
            effective_timeout_ms: args.timeout_ms,
            duration_ms: 12,
          };
        },
      },
    },
  });

  const { createShellTools } = loader.loadModule("src/lib/tools/shellTools.ts");
  const bundle = createShellTools({
    workdir: "/repo",
    providerId: "codex",
    runtimePlatform: "windows",
  });

  assert.match(bundle.tools[0].description, /Windows runs Bash commands/);
  assert.match(bundle.tools[0].description, /Git Bash \(POSIX semantics\)/);
  assert.doesNotMatch(bundle.tools[0].description, /Codex-style auto shell selection/);

  const result = await bundle.executeToolCall(createBashCall());

  assert.equal(result.isError, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.provider_id, "codex");
  assert.equal(calls[0].args.max_timeout_ms, 30_000);
});

test("Bash tool schema allows larger timeout values but clamps for Codex", async () => {
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          calls.push({ command, args });
          assert.equal(command, "shell_run");
          return {
            exit_code: 0,
            shell: "pwsh",
            stdout: "ready\n",
            stderr: "",
            stdout_truncated: false,
            stderr_truncated: false,
            timed_out: false,
            cancelled: false,
            effective_timeout_ms: args.timeout_ms,
            duration_ms: 12,
          };
        },
      },
    },
  });

  const { createShellTools } = loader.loadModule("src/lib/tools/shellTools.ts");
  const bundle = createShellTools({
    workdir: "/repo",
    providerId: "codex",
  });

  assert.match(JSON.stringify(bundle.tools[0].parameters), /"maximum":600000/);
  assert.equal(bundle.tools[0].parameters.additionalProperties, false);

  const result = await bundle.executeToolCall({
    ...createBashCall(),
    arguments: {
      command: "echo ready",
      timeout_ms: 60_000,
    },
  });

  assert.equal(result.isError, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.timeout_ms, 30_000);
  assert.match(result.content[0].text, /timeout_ms: 30000/);
});

test("Bash tool rejects unsupported root arguments", async () => {
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          calls.push({ command, args });
          throw new Error("unexpected invoke");
        },
      },
    },
  });

  const { createShellTools } = loader.loadModule("src/lib/tools/shellTools.ts");
  const bundle = createShellTools({
    workdir: "/repo",
    providerId: "codex",
  });

  const result = await bundle.executeToolCall({
    ...createBashCall(),
    arguments: {
      root: "workspace",
      command: "echo ready",
    },
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /unsupported argument: root/);
  assert.deepEqual(calls, []);
});

test("Bash tool rejects background commands that keep stdio attached", async () => {
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          calls.push({ command, args });
          throw new Error("unexpected invoke");
        },
      },
    },
  });

  const { createShellTools } = loader.loadModule("src/lib/tools/shellTools.ts");
  const bundle = createShellTools({
    workdir: "/repo",
    providerId: "claude_code",
    runtimePlatform: "linux",
  });

  const result = await bundle.executeToolCall(
    createBashCall("deno run --allow-net main.ts &"),
  );

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Background Bash commands must detach stdout and stderr/);
  assert.match(result.content[0].text, /nohup command > \/tmp\/liveagent-task\.log 2>&1/);
  assert.deepEqual(calls, []);
});

test("Bash tool rejects background commands when redirects belong to another command", async () => {
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          calls.push({ command, args });
          throw new Error("unexpected invoke");
        },
      },
    },
  });

  const { createShellTools } = loader.loadModule("src/lib/tools/shellTools.ts");
  const bundle = createShellTools({
    workdir: "/repo",
    providerId: "claude_code",
    runtimePlatform: "linux",
  });

  const result = await bundle.executeToolCall(
    createBashCall("echo ok > /tmp/previous.log 2>&1; deno run --allow-net main.ts &"),
  );

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Background Bash commands must detach stdout and stderr/);
  assert.deepEqual(calls, []);
});

test("Bash tool rejects background commands with only stderr append redirected", async () => {
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          calls.push({ command, args });
          throw new Error("unexpected invoke");
        },
      },
    },
  });

  const { createShellTools } = loader.loadModule("src/lib/tools/shellTools.ts");
  const bundle = createShellTools({
    workdir: "/repo",
    providerId: "claude_code",
    runtimePlatform: "linux",
  });

  const result = await bundle.executeToolCall(
    createBashCall("deno run --allow-net main.ts 2>> /tmp/server.err &"),
  );

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Background Bash commands must detach stdout and stderr/);
  assert.deepEqual(calls, []);
});

test("Bash tool applies POSIX ampersand background validation on Windows", async () => {
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          calls.push({ command, args });
          throw new Error("shell_run should not be invoked for rejected commands");
        },
      },
    },
  });

  const { createShellTools } = loader.loadModule("src/lib/tools/shellTools.ts");
  const bundle = createShellTools({
    workdir: "/repo",
    providerId: "codex",
    runtimePlatform: "windows",
  });

  const result = await bundle.executeToolCall(
    createBashCall("deno run --allow-net main.ts 2>> /tmp/server.err &"),
  );

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Background Bash commands must detach stdout and stderr/);
  assert.equal(calls.length, 0);
});

test("Bash tool allows detached background commands on Windows", async () => {
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          calls.push({ command, args });
          assert.equal(command, "shell_run");
          return {
            exit_code: 0,
            shell: "bash",
            platform: "windows",
            profile: "windows-git-bash",
            shell_family: "posix",
            stdout: "ok\n",
            stderr: "",
            stdout_truncated: false,
            stderr_truncated: false,
            timed_out: false,
            cancelled: false,
            effective_timeout_ms: args.timeout_ms,
            duration_ms: 12,
          };
        },
      },
    },
  });

  const { createShellTools } = loader.loadModule("src/lib/tools/shellTools.ts");
  const bundle = createShellTools({
    workdir: "/repo",
    providerId: "codex",
    runtimePlatform: "windows",
  });

  const result = await bundle.executeToolCall(
    createBashCall("nohup deno run main.ts > /tmp/liveagent-test.log 2>&1 < /dev/null &"),
  );

  assert.equal(result.isError, false);
  assert.equal(calls.length, 1);
});

function createWindowsFailureLoader(shellFamily, shell) {
  return createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          assert.equal(command, "shell_run");
          return {
            exit_code: 1,
            shell,
            platform: "windows",
            profile: shellFamily === "posix" ? "windows-git-bash" : "windows-pwsh",
            shell_family: shellFamily,
            stdout: "",
            stderr: "export : The term 'export' is not recognized",
            stdout_truncated: false,
            stderr_truncated: false,
            timed_out: false,
            cancelled: false,
            effective_timeout_ms: args.timeout_ms,
            duration_ms: 12,
          };
        },
      },
    },
  });
}

test("Bash tool hints about missing Git Bash when Windows falls back to PowerShell", async () => {
  const loader = createWindowsFailureLoader("powershell", "pwsh");
  const { createShellTools } = loader.loadModule("src/lib/tools/shellTools.ts");
  const bundle = createShellTools({
    workdir: "/repo",
    providerId: "claude_code",
    runtimePlatform: "windows",
  });

  const result = await bundle.executeToolCall(createBashCall("export NAME=value"));

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Git Bash was not found/);
  assert.match(result.content[0].text, /LIVEAGENT_GIT_BASH_PATH/);
});

test("Bash tool does not hint about Git Bash when a Windows failure ran under Git Bash", async () => {
  const loader = createWindowsFailureLoader("posix", "bash");
  const { createShellTools } = loader.loadModule("src/lib/tools/shellTools.ts");
  const bundle = createShellTools({
    workdir: "/repo",
    providerId: "claude_code",
    runtimePlatform: "windows",
  });

  const result = await bundle.executeToolCall(createBashCall("exit 1"));

  assert.equal(result.isError, true);
  assert.doesNotMatch(result.content[0].text, /Git Bash was not found/);
});

test("Bash tool allows background commands with detached stdio", async () => {
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          calls.push({ command, args });
          assert.equal(command, "shell_run");
          return {
            exit_code: 0,
            shell: "zsh",
            stdout: "",
            stderr: "",
            stdout_truncated: false,
            stderr_truncated: false,
            timed_out: false,
            cancelled: false,
            effective_timeout_ms: args.timeout_ms,
            duration_ms: 12,
          };
        },
      },
    },
  });

  const { createShellTools } = loader.loadModule("src/lib/tools/shellTools.ts");
  const bundle = createShellTools({
    workdir: "/repo",
    providerId: "claude_code",
  });

  const result = await bundle.executeToolCall(
    createBashCall("nohup deno run main.ts > /tmp/liveagent-test.log 2>&1 < /dev/null &"),
  );

  assert.equal(result.isError, false);
  assert.equal(calls.length, 1);
});

test("ManagedProcess can be omitted from shell tools for non-chat runtimes", async () => {
  const loader = createTsModuleLoader();
  const { createShellTools } = loader.loadModule("src/lib/tools/shellTools.ts");
  const bundle = createShellTools({
    workdir: "/repo",
    providerId: "claude_code",
    managedProcessEnabled: false,
  });

  assert.equal(bundle.tools.some((tool) => tool.name === "ManagedProcess"), false);
  assert.equal(bundle.tools.some((tool) => tool.name === "ProcessWait"), false);
  assert.equal(bundle.tools.some((tool) => tool.name === "ProcessStop"), false);
  assert.equal(bundle.metadataByName.has("ManagedProcess"), false);
  assert.equal(bundle.metadataByName.has("ProcessWait"), false);
  assert.equal(bundle.metadataByName.has("ProcessStop"), false);

  const result = await bundle.executeToolCall({
    type: "toolCall",
    id: "managed-disabled",
    name: "ManagedProcess",
    arguments: {
      action: "status",
    },
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Unknown tool/);
});

test("ManagedProcess starts foreground commands through process manager", async () => {
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          calls.push({ command, args });
          assert.equal(command, "managed_process_start");
          return {
            process: {
              id: "proc-1",
              label: "dev",
              command: args.command,
              cwd: "/repo/app",
              shell: "zsh",
              pid: 123,
              log_path: "/Users/me/.liveagent/process-logs/proc-1.log",
              started_at: 10,
              finished_at: null,
              exit_code: null,
              running: true,
            },
          };
        },
      },
    },
  });

  const { createShellTools } = loader.loadModule("src/lib/tools/shellTools.ts");
  const bundle = createShellTools({
    workdir: "/repo",
    providerId: "claude_code",
  });

  assert.ok(bundle.hasOwnProperty("tools"));
  assert.ok(bundle.tools.some((tool) => tool.name === "ManagedProcess"));

  const result = await bundle.executeToolCall({
    type: "toolCall",
    id: "managed-start",
    name: "ManagedProcess",
    arguments: {
      action: "start",
      command: "deno run --allow-net main.ts",
      cwd: "app",
      label: "dev",
    },
  });

  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /ManagedProcess started/);
  assert.match(result.content[0].text, /id=proc-1/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.workdir, "/repo");
  assert.equal(calls[0].args.cwd, "app");
});

test("ManagedProcess abort stops a process returned after cancellation", async () => {
  let resolveStart;
  const startPromise = new Promise((resolve) => {
    resolveStart = resolve;
  });
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          calls.push({ command, args });
          if (command === "managed_process_start") {
            return startPromise;
          }
          if (command === "managed_process_stop") {
            return undefined;
          }
          throw new Error("unexpected invoke " + command);
        },
      },
    },
  });
  const { createShellTools } = loader.loadModule("src/lib/tools/shellTools.ts");
  const bundle = createShellTools({
    workdir: "/repo",
    providerId: "claude_code",
  });
  const controller = new AbortController();

  const resultPromise = bundle.executeToolCall(
    {
      type: "toolCall",
      id: "managed-cancelled-start",
      name: "ManagedProcess",
      arguments: {
        action: "start",
        command: "deno run --allow-net main.ts",
      },
    },
    controller.signal,
  );
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  const result = await resultPromise;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Cancelled/);

  resolveStart({
    process: {
      id: "proc-late",
      label: "dev",
      command: "deno run --allow-net main.ts",
      cwd: "/repo",
      shell: "zsh",
      pid: 123,
      log_path: "/tmp/proc-late.log",
      started_at: 10,
      finished_at: null,
      exit_code: null,
      running: true,
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(
    calls.some(
      (call) =>
        call.command === "managed_process_stop" && call.args.process_id === "proc-late",
    ),
  );
});

test("ManagedProcess rejects nested shell background operators", async () => {
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          calls.push({ command, args });
          throw new Error("unexpected invoke");
        },
      },
    },
  });

  const { createShellTools } = loader.loadModule("src/lib/tools/shellTools.ts");
  const bundle = createShellTools({
    workdir: "/repo",
    providerId: "claude_code",
    runtimePlatform: "linux",
  });

  const result = await bundle.executeToolCall({
    type: "toolCall",
    id: "managed-start-bad",
    name: "ManagedProcess",
    arguments: {
      action: "start",
      command: "deno run main.ts &",
    },
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /must be a foreground command/);
  assert.deepEqual(calls, []);
});

test("ManagedProcess rejects background ampersand commands on Windows", async () => {
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          calls.push({ command, args });
          throw new Error("managed_process_start should not be invoked for rejected commands");
        },
      },
    },
  });

  const { createShellTools } = loader.loadModule("src/lib/tools/shellTools.ts");
  const bundle = createShellTools({
    workdir: "/repo",
    providerId: "claude_code",
    runtimePlatform: "windows",
  });

  const result = await bundle.executeToolCall({
    type: "toolCall",
    id: "managed-start-windows",
    name: "ManagedProcess",
    arguments: {
      action: "start",
      command: "vite --port 5173 &",
    },
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /must be a foreground command/);
  assert.equal(calls.length, 0);
});

test("Bash tool marks stdio-open shell responses as errors", async () => {
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          assert.equal(command, "shell_run");
          return {
            exit_code: 0,
            shell: "zsh",
            stdout: "ready\n",
            stderr: "LiveAgent warning: command exited, but stdout/stderr remained open after exit.",
            stdout_truncated: false,
            stderr_truncated: true,
            timed_out: false,
            cancelled: false,
            stdio_open_after_exit: true,
            effective_timeout_ms: args.timeout_ms,
            duration_ms: 1010,
          };
        },
      },
    },
  });

  const { createShellTools } = loader.loadModule("src/lib/tools/shellTools.ts");
  const bundle = createShellTools({
    workdir: "/repo",
    providerId: "claude_code",
  });

  const result = await bundle.executeToolCall(createBashCall("echo ready"));

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /stdio_open_after_exit: true/);
  assert.match(result.content[0].text, /stdout\/stderr remained open/);
});

test("Bash tool can execute from the fixed Skills root with relative cwd", async () => {
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          calls.push({ command, args });
          assert.equal(command, "shell_run");
          return {
            exit_code: 0,
            shell: "zsh",
            stdout: "ok\n",
            stderr: "",
            stdout_truncated: false,
            stderr_truncated: false,
            timed_out: false,
            cancelled: false,
            effective_timeout_ms: args.timeout_ms,
            duration_ms: 12,
          };
        },
      },
    },
  });

  const { createShellTools } = loader.loadModule("src/lib/tools/shellTools.ts");
  const bundle = createShellTools({
    workdir: "/repo",
    providerId: "claude_code",
    skillsRootEnabled: true,
    skillsRootDir: "/Users/me/.liveagent/skills",
  });

  assert.match(JSON.stringify(bundle.tools[0].parameters), /skill:\/\//);

  const result = await bundle.executeToolCall({
    type: "toolCall",
    id: "call-skill-bash",
    name: "Bash",
    arguments: {
      cwd: "skill://metaphysics-steward/scripts",
      command: "python3 steward.py --mode qimen",
      timeout_ms: 1000,
    },
  });

  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /cwd: skill:\/\/metaphysics-steward\/scripts/);
  assert.equal(calls[0].args.workdir, "/repo");
  assert.equal(calls[0].args.cwd, "/Users/me/.liveagent/skills/metaphysics-steward/scripts");
});

test("Bash tool allows enabled Skill scripts by direct absolute path without cd", async () => {
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          calls.push({ command, args });
          assert.equal(command, "shell_run");
          return {
            exit_code: 0,
            shell: "zsh",
            stdout: "ok\n",
            stderr: "",
            stdout_truncated: false,
            stderr_truncated: false,
            timed_out: false,
            cancelled: false,
            effective_timeout_ms: args.timeout_ms,
            duration_ms: 12,
          };
        },
      },
    },
  });

  const { createShellTools } = loader.loadModule("src/lib/tools/shellTools.ts");
  const bundle = createShellTools({
    workdir: "/repo",
    providerId: "claude_code",
    skillsRootEnabled: true,
    skillsRootDir: "/Users/me/.liveagent/skills",
    skillAccessPolicy: {
      allowedSkillNames: ["metaphysics-steward"],
      allowedSkillBaseDirs: ["metaphysics-steward"],
    },
  });

  const command =
    "python3 /Users/me/.liveagent/skills/metaphysics-steward/scripts/steward.py --mode qimen";
  const result = await bundle.executeToolCall({
    type: "toolCall",
    id: "call-absolute-skill-script",
    name: "Bash",
    arguments: {
      command,
      timeout_ms: 1000,
    },
  });

  assert.equal(result.isError, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.workdir, "/repo");
  assert.equal(calls[0].args.command, command);
});

test("Bash tool enforces enabled Skill allowlist for skill cwd", async () => {
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          calls.push({ command, args });
          throw new Error("unexpected invoke");
        },
      },
    },
  });

  const { createShellTools } = loader.loadModule("src/lib/tools/shellTools.ts");
  const bundle = createShellTools({
    workdir: "/repo",
    providerId: "claude_code",
    skillsRootEnabled: true,
    skillsRootDir: "/Users/me/.liveagent/skills",
    skillAccessPolicy: {
      allowedSkillNames: ["skills-creator"],
      allowedSkillBaseDirs: ["skills-creator"],
    },
  });

  const result = await bundle.executeToolCall({
    type: "toolCall",
    id: "blocked-skill-bash-cwd",
    name: "Bash",
    arguments: {
      cwd: "skill://metaphysics-steward/scripts",
      command: "python3 steward.py --mode qimen",
      timeout_ms: 1000,
    },
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /metaphysics-steward\/scripts.*is not enabled/);
  assert.deepEqual(calls, []);
});

test("Bash tool blocks absolute Skills root access from workspace commands", async () => {
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          calls.push({ command, args });
          throw new Error("unexpected invoke");
        },
      },
    },
  });

  const { createShellTools } = loader.loadModule("src/lib/tools/shellTools.ts");
  const bundle = createShellTools({
    workdir: "/repo",
    providerId: "claude_code",
    skillsRootEnabled: true,
    skillsRootDir: "/Users/me/.liveagent/skills",
    skillAccessPolicy: {
      allowedSkillNames: ["metaphysics-steward"],
      allowedSkillBaseDirs: ["metaphysics-steward"],
    },
  });

  const result = await bundle.executeToolCall({
    type: "toolCall",
    id: "blocked-absolute-skill-bash",
    name: "Bash",
    arguments: {
      command:
        "cd /Users/me/.liveagent/skills/metaphysics-steward/scripts && python3 steward.py --mode qimen",
      timeout_ms: 1000,
    },
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Bash cannot cd into the fixed Skills root/);
  assert.deepEqual(calls, []);
});

test("Bash tool blocks fixed Skills root access even when Skills are disabled", async () => {
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          calls.push({ command, args });
          throw new Error("unexpected invoke");
        },
      },
    },
  });

  const { createShellTools } = loader.loadModule("src/lib/tools/shellTools.ts");
  const bundle = createShellTools({
    workdir: "/repo",
    providerId: "claude_code",
  });

  const result = await bundle.executeToolCall({
    type: "toolCall",
    id: "blocked-disabled-skill-bash",
    name: "Bash",
    arguments: {
      command: "cat ~/.liveagent/skills/metaphysics-steward/SKILL.md",
      timeout_ms: 1000,
    },
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Bash cannot read or search ~\/\.liveagent\/skills/);
  assert.deepEqual(calls, []);
});

test("Bash tool blocks workspace skills guesses before shell execution", async () => {
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          calls.push({ command, args });
          throw new Error("unexpected invoke");
        },
      },
    },
  });

  const { createShellTools } = loader.loadModule("src/lib/tools/shellTools.ts");
  const bundle = createShellTools({
    workdir: "/repo",
    providerId: "claude_code",
    skillsRootEnabled: true,
    skillsRootDir: "/Users/me/.liveagent/skills",
  });

  const result = await bundle.executeToolCall({
    type: "toolCall",
    id: "call-bad-skill-bash",
    name: "Bash",
    arguments: {
      command: "cd skills/metaphysics-steward/scripts && python3 steward.py --mode qimen",
      timeout_ms: 1000,
    },
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /workspace skills\/ guesses/);
  assert.match(result.content[0].text, /cwd to skill:\/\/<enabled-skill>\/scripts/);
  assert.deepEqual(calls, []);
});

test("chat shell tools expose resumable Bash, ProcessWait, and ProcessStop schemas", async () => {
  const loader = createTsModuleLoader();
  const { createShellTools } = loader.loadModule("src/lib/tools/shellTools.ts");
  const bundle = createShellTools({
    workdir: "/repo",
    providerId: "codex",
    managedProcessEnabled: false,
    resumableShellEnabled: true,
  });

  assert.deepEqual(
    bundle.tools.map((tool) => tool.name),
    ["Bash", "ProcessWait", "ProcessStop"],
  );
  assert.match(JSON.stringify(bundle.tools[0].parameters), /yield_time_ms/);
  assert.match(JSON.stringify(bundle.tools[1].parameters), /"maximum":300000/);
  assert.match(bundle.tools[0].description, /session_duration_ms as cumulative/);
  assert.match(bundle.tools[1].description, /must not be added across responses/);
  assert.match(bundle.tools[1].description, /completed, failed, cancelled, and timed_out/);
  assert.match(bundle.tools[2].description, /status=cancelled/);
  assert.equal(bundle.metadataByName.get("ProcessWait").isReadOnly, true);
  assert.equal(bundle.metadataByName.get("ProcessStop").isReadOnly, false);
});

test("resumable Bash yields a session without applying an implicit hard timeout", async () => {
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          calls.push({ command, args });
          assert.equal(command, "shell_session_start");
          return {
            status: "running",
            session_id: args.session_id,
            cursor: 6,
            output: [{ stream: "stdout", text: "start\n" }],
            output_truncated: false,
            has_more: false,
            exit_code: null,
            duration_ms: 10_003,
            shell: "zsh",
            platform: "macos",
            profile: "posix-zsh",
            shell_family: "posix",
            timeout_ms: null,
          };
        },
      },
    },
  });
  const { createShellTools } = loader.loadModule("src/lib/tools/shellTools.ts");
  const bundle = createShellTools({
    workdir: "/repo",
    providerId: "codex",
    managedProcessEnabled: false,
    resumableShellEnabled: true,
  });

  const result = await bundle.executeToolCall({
    type: "toolCall",
    id: "compile",
    name: "Bash",
    arguments: { command: "pnpm build" },
  });

  assert.equal(result.isError, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.yield_time_ms, 10_000);
  assert.equal(calls[0].args.timeout_ms, undefined);
  // Resumable 模式下 provider cap 不适用：显式 timeout_ms 与 max_timeout_ms
  // 都按全局上限（600s）收敛，避免 codex 系 30s cap 误杀长任务。
  assert.equal(calls[0].args.max_timeout_ms, 600_000);
  assert.equal(calls[0].args.provider_id, undefined);
  assert.match(result.content[0].text, /status: running/);
  assert.match(result.content[0].text, /session_duration_ms: 10003/);
  assert.doesNotMatch(result.content[0].text, /^duration_ms:/m);
  assert.equal(result.details.duration_ms, 10_003);
  assert.match(result.content[0].text, /Continue with ProcessWait/);
  assert.doesNotMatch(result.content[0].text, /Bash sleep 10/);
});

test("sandboxed resumable Bash forwards the sandbox contract to the session", async () => {
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          calls.push({ command, args });
          assert.equal(command, "shell_session_start");
          return {
            status: "completed",
            session_id: args.session_id,
            cursor: 0,
            output: [],
            output_truncated: false,
            has_more: false,
            exit_code: 0,
            duration_ms: 5,
            shell: "bash",
            platform: "windows",
            profile: "windows-git-bash",
            shell_family: "posix",
            sandbox: "restricted-token",
            timeout_ms: null,
          };
        },
      },
    },
  });
  const { createShellTools } = loader.loadModule("src/lib/tools/shellTools.ts");
  const bundle = createShellTools({
    workdir: "D:/workspace/project",
    providerId: "codex",
    runtimePlatform: "windows",
    managedProcessEnabled: false,
    resumableShellEnabled: true,
    sandbox: { enabled: true, allowNetwork: true },
  });

  const result = await bundle.executeToolCall({
    type: "toolCall",
    id: "sandboxed-session",
    name: "Bash",
    arguments: { command: "echo probe" },
  });

  assert.equal(result.isError, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.sandbox, true);
  assert.equal(calls[0].args.sandbox_allow_network, true);
  assert.match(result.content[0].text, /sandbox: restricted-token/);
});

test("resumable Bash stops a running session returned after cancellation", async () => {
  let resolveStart;
  let startResolved = false;
  const startPromise = new Promise((resolve) => {
    resolveStart = resolve;
  });
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          calls.push({ command, args, startResolved });
          if (command === "shell_session_start") return startPromise;
          if (command === "shell_session_stop") {
            if (!startResolved) throw new Error("session not started yet");
            return {
              status: "cancelled",
              session_id: args.session_id,
              cursor: args.cursor ?? 0,
              output: [],
              output_truncated: false,
              has_more: false,
              exit_code: -1,
              duration_ms: 400,
              shell: "bash",
            };
          }
          throw new Error("unexpected invoke " + command);
        },
      },
    },
  });
  const { createShellTools } = loader.loadModule("src/lib/tools/shellTools.ts");
  const bundle = createShellTools({
    workdir: "/repo",
    providerId: "codex",
    managedProcessEnabled: false,
    resumableShellEnabled: true,
  });
  const controller = new AbortController();

  const resultPromise = bundle.executeToolCall(
    {
      type: "toolCall",
      id: "cancelled-compile",
      name: "Bash",
      arguments: { command: "pnpm build" },
    },
    controller.signal,
  );
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  const result = await resultPromise;
  assert.equal(result.details.status, "cancelled");

  await new Promise((resolve) => setTimeout(resolve, 300));
  startResolved = true;
  const sessionId = calls.find((call) => call.command === "shell_session_start").args.session_id;
  resolveStart({
    status: "running",
    session_id: sessionId,
    cursor: 9,
    output: [{ stream: "stdout", text: "building\n" }],
    output_truncated: false,
    has_more: false,
    exit_code: null,
    duration_ms: 10_000,
    shell: "bash",
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(
    calls.some(
      (call) =>
        call.command === "shell_session_stop" &&
        call.startResolved === true &&
        call.args.session_id === sessionId &&
        call.args.cursor === 9,
    ),
  );
});

test("ProcessWait paginates a Bash session and ProcessStop terminates it", async () => {
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          calls.push({ command, args });
          if (command === "shell_session_wait") {
            return {
              status: "running",
              session_id: args.session_id,
              cursor: 12,
              output: [{ stream: "stderr", text: "building\n" }],
              output_truncated: false,
              has_more: false,
              exit_code: null,
              duration_ms: 40_000,
              shell: "bash",
            };
          }
          assert.equal(command, "shell_session_stop");
          return {
            status: "cancelled",
            session_id: args.session_id,
            cursor: 14,
            output: [{ stream: "stdout", text: "x\n" }],
            output_truncated: false,
            has_more: false,
            exit_code: -1,
            duration_ms: 40_100,
            shell: "bash",
          };
        },
      },
    },
  });
  const { createShellTools } = loader.loadModule("src/lib/tools/shellTools.ts");
  const bundle = createShellTools({
    workdir: "/repo",
    providerId: "codex",
    managedProcessEnabled: false,
    resumableShellEnabled: true,
  });

  const waited = await bundle.executeToolCall({
    type: "toolCall",
    id: "wait",
    name: "ProcessWait",
    arguments: { session_id: "bash-session", cursor: 6, yield_time_ms: 999_999 },
  });
  const stopped = await bundle.executeToolCall({
    type: "toolCall",
    id: "stop",
    name: "ProcessStop",
    arguments: { session_id: "bash-session", cursor: 12 },
  });

  assert.equal(calls[0].command, "shell_session_wait");
  assert.equal(calls[0].args.yield_time_ms, 300_000);
  assert.equal(calls[1].command, "shell_session_stop");
  assert.equal(calls[1].args.cursor, 12);
  assert.match(waited.content[0].text, /building/);
  assert.match(waited.content[0].text, /session_duration_ms: 40000/);
  assert.doesNotMatch(waited.content[0].text, /^duration_ms:/m);
  assert.match(stopped.content[0].text, /status: cancelled/);
  assert.match(stopped.content[0].text, /session_duration_ms: 40100/);
  assert.equal(stopped.isError, false);
});

test("resumable Bash blocks leading sleep polling but allows short or internal sleeps", async () => {
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          calls.push({ command, args });
          return {
            status: "completed",
            session_id: args.session_id,
            cursor: 0,
            output: [],
            output_truncated: false,
            has_more: false,
            exit_code: 0,
            duration_ms: 1,
            shell: "bash",
          };
        },
      },
    },
  });
  const { createShellTools } = loader.loadModule("src/lib/tools/shellTools.ts");
  const bundle = createShellTools({
    workdir: "/repo",
    providerId: "codex",
    managedProcessEnabled: false,
    resumableShellEnabled: true,
  });

  for (const command of ["sleep 28", "sleep 28 && status", "sleep 28; status"]) {
    const result = await bundle.executeToolCall(createBashCall(command));
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Call ProcessWait/);
  }
  assert.equal(calls.length, 0);

  assert.equal((await bundle.executeToolCall(createBashCall("sleep 0.5"))).isError, false);
  assert.equal(
    (await bundle.executeToolCall(createBashCall("echo ready; sleep 28"))).isError,
    false,
  );
  assert.equal(calls.length, 2);
});
