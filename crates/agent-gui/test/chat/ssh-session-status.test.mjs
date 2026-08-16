import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// SSH 会话状态推导与端点标签:SshTerminalPaneSurface / WorkspaceSshTerminalOverlay 共用。

const loader = createTsModuleLoader();
const { sshSessionStatus, sshSessionEndpointLabel } = loader.loadModule(
  "../agent-ui/src/lib/terminal/sshSessionStatus.ts",
);

function sshSession(overrides = {}, sshOverrides = {}) {
  return {
    id: "ssh-1",
    projectPathKey: "/proj",
    cwd: "/proj",
    shell: "ssh",
    title: "host",
    kind: "ssh",
    running: true,
    cols: 80,
    rows: 24,
    createdAt: 1,
    updatedAt: 1,
    ssh: {
      hostId: "h1",
      hostName: "host",
      username: "root",
      host: "10.0.0.1",
      port: 22,
      authType: "key",
      status: "connected",
      reconnectAttempt: 0,
      reconnectMaxAttempts: 3,
      sftpEnabled: false,
      ...sshOverrides,
    },
    ...overrides,
  };
}

test("connected status passes through while the session is running", () => {
  assert.equal(sshSessionStatus(sshSession()), "connected");
});

test("connected status downgrades to disconnected once the process stops", () => {
  assert.equal(sshSessionStatus(sshSession({ running: false })), "disconnected");
});

test("reconnecting status passes through", () => {
  assert.equal(sshSessionStatus(sshSession({}, { status: "reconnecting" })), "reconnecting");
});

test("unknown backend status is treated as disconnected", () => {
  assert.equal(sshSessionStatus(sshSession({}, { status: "handshaking" })), "disconnected");
});

test("missing ssh metadata falls back to running flag", () => {
  assert.equal(sshSessionStatus(sshSession({ ssh: undefined })), "connected");
  assert.equal(sshSessionStatus(sshSession({ ssh: undefined, running: false })), "disconnected");
});

test("endpoint label renders user@host:port and falls back to cwd", () => {
  assert.equal(sshSessionEndpointLabel(sshSession()), "root@10.0.0.1:22");
  assert.equal(
    sshSessionEndpointLabel(sshSession({}, { username: "  " })),
    "10.0.0.1:22",
  );
  assert.equal(sshSessionEndpointLabel(sshSession({ ssh: undefined })), "/proj");
});
