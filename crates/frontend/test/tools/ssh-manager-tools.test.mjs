import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Battle 2: this suite now drives crates/core, the engine that actually ships.
// The frontend copy under src/lib was a duplicate and has been removed.
// crates/core modules that talk to the Rust backend read this at import time.
process.env.LIVEAGENT_BACKEND_PORT ??= "0";
const coreRootDir = path.resolve(fileURLToPath(new URL("../..", import.meta.url)), "../core");
const coreSrc = (rel) => path.join(coreRootDir, "src", rel);
// core 走 HTTP callBackend，前端副本走 tauri invoke —— 迁移后 mock 换成前者。
const backendClientPath = coreSrc("backendClient.ts");

const SSH_HOST = {
  id: "host-1",
  name: "Prod",
  description: "Production host",
  host: "ssh.example.test",
  port: 22,
  username: "deploy",
  authType: "privateKey",
  password: "secret-password",
  privateKey: "secret-key",
  privateKeyPath: "/Users/me/.ssh/id_rsa",
  privateKeyPassphrase: "secret-passphrase",
  proxy: {
    type: "socks5",
    url: "",
    port: 0,
    username: "",
    password: "",
  },
};

function createToolCall(args) {
  return {
    type: "toolCall",
    id: "call-ssh",
    name: "SSHManager",
    arguments: args,
  };
}

function createSshSession(overrides = {}) {
  return {
    id: "ssh-session-1",
    projectPathKey: "/workspace",
    cwd: "/workspace",
    shell: "ssh",
    title: "SSHManager: Prod",
    kind: "ssh",
    ssh: {
      hostId: "host-1",
      hostName: "Prod",
      username: "deploy",
      host: "ssh.example.test",
      port: 22,
      authType: "privateKey",
      status: "connected",
      sftpEnabled: true,
    },
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    running: true,
    ...overrides,
  };
}

async function buildRegistry(params = {}) {
  const loader = createTsModuleLoader();
  const { buildBuiltinToolRegistry } = loader.loadModule(coreSrc("tools/builtinRegistry.ts"));
  const { createFileToolState } = loader.loadModule(coreSrc("tools/fileToolState.ts"));
  return buildBuiltinToolRegistry({
    workdir: "/workspace",
    providerId: "codex",
    fileState: createFileToolState(),
    skillsEnabled: false,
    runtimeScope: "chat",
    currentChatModel: { customProviderId: "p", model: "m" },
    getMcpSettings: () => ({ selected: [], servers: [] }),
    sshHosts: [SSH_HOST],
    associatedSshHostIds: ["host-1"],
    tunnelProjectPathKey: "/workspace",
    ...params,
  });
}

test("SSHManager is auto-registered by project hosts, runtime, and remote switch", async () => {
  const registry = await buildRegistry();
  assert.equal(registry.hasTool("SSHManager"), true);
  assert.equal(registry.metadataByName.get("SSHManager").kind, "ssh_manager");
  assert.equal(registry.metadataByName.get("SSHManager").displayCategory, "terminal");

  assert.equal(
    (
      await buildRegistry({
        associatedSshHostIds: [],
      })
    ).hasTool("SSHManager"),
    false,
  );

  assert.equal(
    (
      await buildRegistry({
        runtimeScope: "cron_auto_prompt",
      })
    ).hasTool("SSHManager"),
    false,
  );

  assert.equal(
    (
      await buildRegistry({
        sshManagerRemoteAllowed: false,
      })
    ).hasTool("SSHManager"),
    false,
  );
});

test("SSHManager list_hosts redacts configured secrets", async () => {
  const loader = createTsModuleLoader();
  const { createSSHManagerTools } = loader.loadModule(coreSrc("tools/sshManagerTools.ts"));
  const bundle = createSSHManagerTools({
    enabled: true,
    runtimeScope: "chat",
    workdir: "/workspace",
    projectPathKey: "/workspace",
    hosts: [SSH_HOST],
    associatedHostIds: ["host-1"],
  });

  const result = await bundle.executeToolCall(createToolCall({ action: "list_hosts" }));
  assert.equal(result.isError, false);
  assert.deepEqual(result.details.hosts, [
    {
      host_id: "host-1",
      name: "Prod",
      endpoint: "deploy@ssh.example.test:22",
      username: "deploy",
      host: "ssh.example.test",
      port: 22,
      authType: "privateKey",
      credentialConfigured: true,
      credentialStatus: "saved",
    },
  ]);
  assert.doesNotMatch(result.content[0].text, /secret|privateKeyPath|passphrase/i);
  assert.match(result.content[0].text, /credential=saved/);
  assert.match(result.content[0].text, /do not ask the user/i);
  assert.equal(JSON.stringify(result.details).includes("secret"), false);
});

test("SSHManager create_session defaults SFTP on and refuses SSH prompts", async () => {
  const invocations = [];
  const changes = [];
  const loader = createTsModuleLoader({
    mocks: {
      [backendClientPath]: {
        async callBackend(command, args) {
          invocations.push({ command, args });
          if (command === "terminal_create_ssh") {
            return { session: createSshSession(), output: "", truncated: false };
          }
          throw new Error(`unexpected invoke ${command}`);
        },
      },
    },
  });
  const { createSSHManagerTools } = loader.loadModule(coreSrc("tools/sshManagerTools.ts"));
  const bundle = createSSHManagerTools({
    enabled: true,
    runtimeScope: "chat",
    workdir: "/workspace",
    projectPathKey: "/workspace",
    hosts: [SSH_HOST],
    associatedHostIds: ["host-1"],
    onSshSessionsChanged: (change) => changes.push(change),
  });

  const result = await bundle.executeToolCall(
    createToolCall({ action: "create_session", host_id: "host-1" }),
  );
  assert.equal(result.isError, false);
  assert.equal(result.details.session.session_id, "ssh-session-1");
  assert.deepEqual(changes, [{ action: "create", projectPathKey: "/workspace" }]);
  assert.deepEqual(invocations, [
    {
      command: "terminal_create_ssh",
      args: {
        cwd: "/workspace",
        project_path_key: "/workspace",
        ssh_host_id: "host-1",
        title: undefined,
        cols: undefined,
        rows: undefined,
        sftp_enabled: true,
      },
    },
  ]);
});

test("SSHManager exec auto-creates a visible session before running command", async () => {
  const invocations = [];
  const changes = [];
  const loader = createTsModuleLoader({
    mocks: {
      [backendClientPath]: {
        async callBackend(command, args) {
          invocations.push({ command, args });
          if (command === "terminal_list") {
            return { sessions: [] };
          }
          if (command === "terminal_create_ssh") {
            return { session: createSshSession(), output: "", truncated: false };
          }
          if (command === "terminal_ssh_exec") {
            return {
              sessionId: args.session_id,
              command: args.command,
              cwd: args.cwd,
              exitCode: 0,
              stdout: "ok\n",
              stderr: "",
              timedOut: false,
            };
          }
          throw new Error(`unexpected invoke ${command}`);
        },
      },
    },
  });
  const { createSSHManagerTools } = loader.loadModule(coreSrc("tools/sshManagerTools.ts"));
  const bundle = createSSHManagerTools({
    enabled: true,
    runtimeScope: "chat",
    workdir: "/workspace",
    projectPathKey: "/workspace",
    hosts: [SSH_HOST],
    associatedHostIds: ["host-1"],
    onSshSessionsChanged: (change) => changes.push(change),
  });

  const result = await bundle.executeToolCall(
    createToolCall({
      action: "exec",
      host_id: "host-1",
      command: "pwd",
      cwd: "/srv/app",
      timeout_ms: 5_000,
    }),
  );
  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /stdout:\nok/);
  assert.deepEqual(
    invocations.map((call) => call.command),
    ["terminal_list", "terminal_create_ssh", "terminal_ssh_exec"],
  );
  assert.equal(invocations[2].args.session_id, "ssh-session-1");
  assert.equal(invocations[2].args.command, "pwd");
  assert.equal(invocations[2].args.cwd, "/srv/app");
  assert.deepEqual(changes, [{ action: "create", projectPathKey: "/workspace" }]);
  assert.equal(result.details.session_reused, false);
  assert.equal(result.details.session_created, true);
});

test("SSHManager exec abort requests runtime cancellation", async () => {
  let resolveExec;
  const execPromise = new Promise((resolve) => {
    resolveExec = resolve;
  });
  const invocations = [];
  const loader = createTsModuleLoader({
    mocks: {
      [backendClientPath]: {
        async callBackend(command, args) {
          invocations.push({ command, args });
          if (command === "terminal_list") {
            return { sessions: [createSshSession()] };
          }
          if (command === "terminal_ssh_exec") {
            return execPromise;
          }
          if (command === "runtime_cancel") {
            return { cancelled: true };
          }
          throw new Error("unexpected invoke " + command);
        },
      },
    },
  });
  const { createSSHManagerTools } = loader.loadModule(coreSrc("tools/sshManagerTools.ts"));
  const bundle = createSSHManagerTools({
    enabled: true,
    runtimeScope: "chat",
    workdir: "/workspace",
    projectPathKey: "/workspace",
    hosts: [SSH_HOST],
    associatedHostIds: ["host-1"],
  });
  const controller = new AbortController();

  const resultPromise = bundle.executeToolCall(
    createToolCall({
      action: "exec",
      host_id: "host-1",
      command: "sleep 30",
    }),
    controller.signal,
  );
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  const result = await resultPromise;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Cancelled/);
  const execCall = invocations.find(
    (call) =>
      call.command === "terminal_ssh_exec" &&
      typeof call.args.run_id === "string" &&
      call.args.run_id.startsWith("ssh-exec:call-ssh:"),
  );
  assert.ok(execCall, "exec must carry a unique ssh-exec run id");
  assert.ok(
    invocations.some(
      (call) => call.command === "runtime_cancel" && call.args.run_id === execCall.args.run_id,
    ),
    "runtime cancel must target the same run id as the exec call",
  );

  resolveExec({ exitCode: 0, stdout: "", stderr: "", timedOut: false });
});

test("SSHManager exec reuses an existing running SSH session for the same host", async () => {
  const invocations = [];
  const changes = [];
  const loader = createTsModuleLoader({
    mocks: {
      [backendClientPath]: {
        async callBackend(command, args) {
          invocations.push({ command, args });
          if (command === "terminal_list") {
            return {
              sessions: [
                createSshSession({
                  id: "older-disconnected",
                  running: false,
                  createdAt: 1,
                }),
                createSshSession({
                  id: "ssh-session-newer",
                  createdAt: 3,
                  ssh: { ...createSshSession().ssh, sftpEnabled: false },
                }),
                createSshSession({
                  id: "ssh-session-reused",
                  createdAt: 2,
                  ssh: { ...createSshSession().ssh, sftpEnabled: false },
                }),
              ],
            };
          }
          if (command === "terminal_ssh_exec") {
            return {
              sessionId: args.session_id,
              command: args.command,
              exitCode: 0,
              stdout: "reused\n",
              stderr: "",
              timedOut: false,
            };
          }
          throw new Error(`unexpected invoke ${command}`);
        },
      },
    },
  });
  const { createSSHManagerTools } = loader.loadModule(coreSrc("tools/sshManagerTools.ts"));
  const bundle = createSSHManagerTools({
    enabled: true,
    runtimeScope: "chat",
    workdir: "/workspace",
    projectPathKey: "/workspace",
    hosts: [SSH_HOST],
    associatedHostIds: ["host-1"],
    onSshSessionsChanged: (change) => changes.push(change),
  });

  const result = await bundle.executeToolCall(
    createToolCall({
      action: "exec",
      host_id: "host-1",
      command: "whoami",
    }),
  );
  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /session_reused: true/);
  assert.deepEqual(
    invocations.map((call) => call.command),
    ["terminal_list", "terminal_ssh_exec"],
  );
  assert.equal(invocations[1].args.session_id, "ssh-session-reused");
  assert.deepEqual(changes, []);
  assert.equal(result.details.session_strategy, "reuse_or_create");
  assert.equal(result.details.session_reused, true);
  assert.equal(result.details.session_created, false);
});

test("SSHManager exec can intentionally create an additional SSH session", async () => {
  const invocations = [];
  const loader = createTsModuleLoader({
    mocks: {
      [backendClientPath]: {
        async callBackend(command, args) {
          invocations.push({ command, args });
          if (command === "terminal_create_ssh") {
            return {
              session: createSshSession({
                id: "ssh-session-second",
                title: args.title,
              }),
              output: "",
              truncated: false,
            };
          }
          if (command === "terminal_ssh_exec") {
            return {
              sessionId: args.session_id,
              command: args.command,
              exitCode: 0,
              stdout: "second\n",
              stderr: "",
              timedOut: false,
            };
          }
          throw new Error(`unexpected invoke ${command}`);
        },
      },
    },
  });
  const { createSSHManagerTools } = loader.loadModule(coreSrc("tools/sshManagerTools.ts"));
  const bundle = createSSHManagerTools({
    enabled: true,
    runtimeScope: "chat",
    workdir: "/workspace",
    projectPathKey: "/workspace",
    hosts: [SSH_HOST],
    associatedHostIds: ["host-1"],
  });

  const result = await bundle.executeToolCall(
    createToolCall({
      action: "exec",
      host_id: "host-1",
      session_strategy: "new",
      title: "isolated diagnostics",
      command: "hostname",
    }),
  );
  assert.equal(result.isError, false);
  assert.deepEqual(
    invocations.map((call) => call.command),
    ["terminal_create_ssh", "terminal_ssh_exec"],
  );
  assert.equal(invocations[0].args.title, "isolated diagnostics");
  assert.equal(invocations[1].args.session_id, "ssh-session-second");
  assert.equal(result.details.session_strategy, "new");
  assert.equal(result.details.session_reused, false);
  assert.equal(result.details.session_created, true);
});

test("SSHManager can require an existing session without implicitly creating one", async () => {
  const invocations = [];
  const loader = createTsModuleLoader({
    mocks: {
      [backendClientPath]: {
        async callBackend(command, args) {
          invocations.push({ command, args });
          if (command === "terminal_list") {
            return { sessions: [] };
          }
          throw new Error(`unexpected invoke ${command}`);
        },
      },
    },
  });
  const { createSSHManagerTools } = loader.loadModule(coreSrc("tools/sshManagerTools.ts"));
  const bundle = createSSHManagerTools({
    enabled: true,
    runtimeScope: "chat",
    workdir: "/workspace",
    projectPathKey: "/workspace",
    hosts: [SSH_HOST],
    associatedHostIds: ["host-1"],
  });

  const result = await bundle.executeToolCall(
    createToolCall({
      action: "exec",
      host_id: "host-1",
      session_strategy: "require_existing",
      command: "pwd",
    }),
  );
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /No reusable SSH session exists/);
  assert.deepEqual(invocations, [
    {
      command: "terminal_list",
      args: { project_path_key: "/workspace" },
    },
  ]);
});

test("SSHManager never dials keyboard-interactive hosts itself", async () => {
  const kbiHost = {
    ...SSH_HOST,
    id: "host-kbi",
    name: "Jump",
    authType: "keyboardInteractive",
    password: "",
    privateKey: "",
    privateKeyPath: "",
    privateKeyPassphrase: "",
  };
  const kbiSession = createSshSession({
    id: "ssh-kbi-running",
    ssh: { ...createSshSession().ssh, hostId: "host-kbi", authType: "keyboardInteractive" },
  });
  const invocations = [];
  let listedSessions = [];
  const loader = createTsModuleLoader({
    mocks: {
      [backendClientPath]: {
        async callBackend(command, args) {
          invocations.push({ command, args });
          if (command === "terminal_list") {
            return { sessions: listedSessions };
          }
          if (command === "terminal_ssh_exec") {
            return {
              sessionId: args.session_id,
              command: args.command,
              exitCode: 0,
              stdout: "ok\n",
              stderr: "",
              timedOut: false,
            };
          }
          throw new Error(`unexpected invoke ${command}`);
        },
      },
    },
  });
  const { createSSHManagerTools } = loader.loadModule(coreSrc("tools/sshManagerTools.ts"));
  const bundle = createSSHManagerTools({
    enabled: true,
    runtimeScope: "chat",
    workdir: "/workspace",
    projectPathKey: "/workspace",
    hosts: [kbiHost],
    associatedHostIds: ["host-kbi"],
  });

  // create_session is refused outright, without touching the terminal runtime.
  const created = await bundle.executeToolCall(
    createToolCall({ action: "create_session", host_id: "host-kbi" }),
  );
  assert.equal(created.isError, true);
  assert.match(created.content[0].text, /键盘交互/);
  assert.deepEqual(invocations, []);

  // exec without a running session errors instead of implicitly connecting.
  const noSession = await bundle.executeToolCall(
    createToolCall({ action: "exec", host_id: "host-kbi", command: "pwd" }),
  );
  assert.equal(noSession.isError, true);
  assert.match(noSession.content[0].text, /键盘交互/);
  assert.deepEqual(
    invocations.map((call) => call.command),
    ["terminal_list"],
  );

  // exec with a user-opened running session reuses it.
  invocations.length = 0;
  listedSessions = [kbiSession];
  const reused = await bundle.executeToolCall(
    createToolCall({ action: "exec", host_id: "host-kbi", command: "whoami" }),
  );
  assert.equal(reused.isError, false);
  assert.deepEqual(
    invocations.map((call) => call.command),
    ["terminal_list", "terminal_ssh_exec"],
  );
  assert.equal(invocations[1].args.session_id, "ssh-kbi-running");
  assert.equal(reused.details.session_reused, true);

  // session_strategy=new never dials either.
  invocations.length = 0;
  const forcedNew = await bundle.executeToolCall(
    createToolCall({
      action: "exec",
      host_id: "host-kbi",
      session_strategy: "new",
      command: "pwd",
    }),
  );
  assert.equal(forcedNew.isError, true);
  assert.match(forcedNew.content[0].text, /键盘交互/);
  assert.deepEqual(invocations, []);
});

test("SSHManager rejects conflicting session_id and new session strategy", async () => {
  const invocations = [];
  const loader = createTsModuleLoader({
    mocks: {
      [backendClientPath]: {
        async callBackend(command, args) {
          invocations.push({ command, args });
          throw new Error(`unexpected invoke ${command}`);
        },
      },
    },
  });
  const { createSSHManagerTools } = loader.loadModule(coreSrc("tools/sshManagerTools.ts"));
  const bundle = createSSHManagerTools({
    enabled: true,
    runtimeScope: "chat",
    workdir: "/workspace",
    projectPathKey: "/workspace",
    hosts: [SSH_HOST],
    associatedHostIds: ["host-1"],
  });

  const result = await bundle.executeToolCall(
    createToolCall({
      action: "exec",
      session_id: "ssh-session-1",
      session_strategy: "new",
      command: "pwd",
    }),
  );
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /cannot be combined/);
  assert.deepEqual(invocations, []);
});

test("SSHManager validates current project sessions before SFTP actions", async () => {
  const invocations = [];
  const loader = createTsModuleLoader({
    mocks: {
      [backendClientPath]: {
        async callBackend(command, args) {
          invocations.push({ command, args });
          if (command === "terminal_list") {
            return { sessions: [createSshSession()] };
          }
          if (command === "sftp_list") {
            return { path: ".", entries: [] };
          }
          throw new Error(`unexpected invoke ${command}`);
        },
      },
    },
  });
  const { createSSHManagerTools } = loader.loadModule(coreSrc("tools/sshManagerTools.ts"));
  const bundle = createSSHManagerTools({
    enabled: true,
    runtimeScope: "chat",
    workdir: "/workspace",
    projectPathKey: "/workspace",
    hosts: [SSH_HOST],
    associatedHostIds: ["host-1"],
  });

  const result = await bundle.executeToolCall(
    createToolCall({
      action: "sftp_list",
      session_id: "ssh-session-1",
      path: "/var/log",
    }),
  );
  assert.equal(result.isError, false);
  assert.deepEqual(invocations, [
    {
      command: "terminal_list",
      args: { project_path_key: "/workspace" },
    },
    {
      command: "sftp_list",
      args: {
        session_id: "ssh-session-1",
        project_path_key: "/workspace",
        workdir: "/workspace",
        side: "remote",
        path: "/var/log",
      },
    },
  ]);
});

test("SSHManager SFTP actions reuse SFTP-enabled host sessions", async () => {
  const invocations = [];
  const loader = createTsModuleLoader({
    mocks: {
      [backendClientPath]: {
        async callBackend(command, args) {
          invocations.push({ command, args });
          if (command === "terminal_list") {
            return {
              sessions: [
                createSshSession({
                  id: "ssh-no-sftp",
                  ssh: { ...createSshSession().ssh, sftpEnabled: false },
                }),
                createSshSession({
                  id: "ssh-sftp-reused",
                  ssh: { ...createSshSession().ssh, sftpEnabled: true },
                }),
              ],
            };
          }
          if (command === "sftp_list") {
            return { path: "/tmp", entries: [] };
          }
          throw new Error(`unexpected invoke ${command}`);
        },
      },
    },
  });
  const { createSSHManagerTools } = loader.loadModule(coreSrc("tools/sshManagerTools.ts"));
  const bundle = createSSHManagerTools({
    enabled: true,
    runtimeScope: "chat",
    workdir: "/workspace",
    projectPathKey: "/workspace",
    hosts: [SSH_HOST],
    associatedHostIds: ["host-1"],
  });

  const result = await bundle.executeToolCall(
    createToolCall({
      action: "sftp_list",
      host_id: "host-1",
      path: "/tmp",
    }),
  );
  assert.equal(result.isError, false);
  assert.deepEqual(
    invocations.map((call) => call.command),
    ["terminal_list", "sftp_list"],
  );
  assert.equal(invocations[1].args.session_id, "ssh-sftp-reused");
  assert.equal(result.details.session_reused, true);
  assert.equal(result.details.session_created, false);
});

test("SSHManager SFTP actions create a new session when no SFTP-enabled session exists", async () => {
  const invocations = [];
  const loader = createTsModuleLoader({
    mocks: {
      [backendClientPath]: {
        async callBackend(command, args) {
          invocations.push({ command, args });
          if (command === "terminal_list") {
            return {
              sessions: [
                createSshSession({
                  id: "ssh-no-sftp",
                  ssh: { ...createSshSession().ssh, sftpEnabled: false },
                }),
              ],
            };
          }
          if (command === "terminal_create_ssh") {
            return {
              session: createSshSession({ id: "ssh-created-for-sftp" }),
              output: "",
              truncated: false,
            };
          }
          if (command === "sftp_stat") {
            return { path: "/tmp", kind: "dir" };
          }
          throw new Error(`unexpected invoke ${command}`);
        },
      },
    },
  });
  const { createSSHManagerTools } = loader.loadModule(coreSrc("tools/sshManagerTools.ts"));
  const bundle = createSSHManagerTools({
    enabled: true,
    runtimeScope: "chat",
    workdir: "/workspace",
    projectPathKey: "/workspace",
    hosts: [SSH_HOST],
    associatedHostIds: ["host-1"],
  });

  const result = await bundle.executeToolCall(
    createToolCall({
      action: "sftp_stat",
      host_id: "host-1",
      path: "/tmp",
    }),
  );
  assert.equal(result.isError, false);
  assert.deepEqual(
    invocations.map((call) => call.command),
    ["terminal_list", "terminal_create_ssh", "sftp_stat"],
  );
  assert.equal(invocations[1].args.sftp_enabled, true);
  assert.equal(invocations[2].args.session_id, "ssh-created-for-sftp");
  assert.equal(result.details.session_reused, false);
  assert.equal(result.details.session_created, true);
});

test("SSHManager SFTP actions can intentionally create an additional SFTP-enabled session", async () => {
  const invocations = [];
  const loader = createTsModuleLoader({
    mocks: {
      [backendClientPath]: {
        async callBackend(command, args) {
          invocations.push({ command, args });
          if (command === "terminal_create_ssh") {
            return {
              session: createSshSession({
                id: "ssh-extra-sftp",
                title: args.title,
              }),
              output: "",
              truncated: false,
            };
          }
          if (command === "sftp_list") {
            return { path: "/var", entries: [] };
          }
          throw new Error(`unexpected invoke ${command}`);
        },
      },
    },
  });
  const { createSSHManagerTools } = loader.loadModule(coreSrc("tools/sshManagerTools.ts"));
  const bundle = createSSHManagerTools({
    enabled: true,
    runtimeScope: "chat",
    workdir: "/workspace",
    projectPathKey: "/workspace",
    hosts: [SSH_HOST],
    associatedHostIds: ["host-1"],
  });

  const result = await bundle.executeToolCall(
    createToolCall({
      action: "sftp_list",
      host_id: "host-1",
      session_strategy: "new",
      title: "isolated sftp",
      path: "/var",
    }),
  );
  assert.equal(result.isError, false);
  assert.deepEqual(
    invocations.map((call) => call.command),
    ["terminal_create_ssh", "sftp_list"],
  );
  assert.equal(invocations[0].args.title, "isolated sftp");
  assert.equal(invocations[0].args.sftp_enabled, true);
  assert.equal(invocations[1].args.session_id, "ssh-extra-sftp");
  assert.equal(result.details.session_strategy, "new");
  assert.equal(result.details.session_reused, false);
  assert.equal(result.details.session_created, true);
});

test("SSHManager rejects unauthorized hosts and cross-project sessions before invoking actions", async () => {
  const invocations = [];
  const loader = createTsModuleLoader({
    mocks: {
      [backendClientPath]: {
        async callBackend(command, args) {
          invocations.push({ command, args });
          if (command === "terminal_list") {
            return {
              sessions: [
                createSshSession({
                  id: "other-session",
                  ssh: { ...createSshSession().ssh, hostId: "other-host" },
                }),
              ],
            };
          }
          throw new Error(`unexpected invoke ${command}`);
        },
      },
    },
  });
  const { createSSHManagerTools } = loader.loadModule(coreSrc("tools/sshManagerTools.ts"));
  const bundle = createSSHManagerTools({
    enabled: true,
    runtimeScope: "chat",
    workdir: "/workspace",
    projectPathKey: "/workspace",
    hosts: [SSH_HOST],
    associatedHostIds: ["host-1"],
  });

  const hostResult = await bundle.executeToolCall(
    createToolCall({ action: "exec", host_id: "other-host", command: "id" }),
  );
  assert.equal(hostResult.isError, true);
  assert.match(hostResult.content[0].text, /not associated/);

  const sessionResult = await bundle.executeToolCall(
    createToolCall({ action: "read_session", session_id: "other-session" }),
  );
  assert.equal(sessionResult.isError, true);
  assert.match(sessionResult.content[0].text, /not authorized|not found/);
  assert.deepEqual(invocations, [
    {
      command: "terminal_list",
      args: { project_path_key: "/workspace" },
    },
  ]);
});
