import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const historyMessageRef = loader.loadModule("@liveagent/ui/lib/chat/historyMessageRef.ts");
const sftp = loader.loadModule("@liveagent/ui/lib/sftp/normalization.ts");
const terminal = loader.loadModule("@liveagent/ui/lib/terminal/normalization.ts");

test("history message references use the gateway snake-case wire shape", () => {
  assert.deepEqual(
    historyMessageRef.buildHistoryMessageRefPayload({
      segmentIndex: 2,
      messageIndex: 7,
      segmentId: "segment-2",
      messageId: "message-7",
      role: "user",
      contentHash: "hash-7",
    }),
    {
      segment_index: 2,
      message_index: 7,
      segment_id: "segment-2",
      message_id: "message-7",
      role: "user",
      content_hash: "hash-7",
    },
  );
});

test("SFTP normalization accepts snake-case wire records", () => {
  const response = sftp.normalizeSftpActionResponse({
    action: "transfer",
    path: "/remote",
    entry: {
      path: "/remote/file.txt",
      name: "file.txt",
      kind: "file",
      size_bytes: 12,
      mtime: 34,
    },
    transfer: {
      id: "transfer-1",
      session_id: "terminal-1",
      direction: "download",
      status: "running",
      source_path: "/remote/file.txt",
      target_path: "/local/file.txt",
      current_path: "/remote/file.txt",
      bytes_done: 5,
      bytes_total: 12,
      files_done: 0,
      files_total: 1,
    },
  });

  assert.equal(response.entry.sizeBytes, 12);
  assert.equal(response.transfer.sessionId, "terminal-1");
  assert.equal(response.transfer.bytesDone, 5);
  assert.equal(response.transfer.filesTotal, 1);
  assert.throws(
    () => sftp.normalizeSftpTransferResponse({}),
    /did not include a transfer/,
  );
  assert.equal(sftp.normalizeSftpTransferEvent({ kind: "progress" }), null);
});

test("SFTP read-text normalization accepts snake and camel wire records", () => {
  const snake = sftp.normalizeSftpReadTextResponse({
    path: "/remote/notes.txt",
    content: "hello",
    offset: 0,
    bytes_read: 5,
    size_bytes: 5,
    truncated: false,
    entry: {
      path: "/remote/notes.txt",
      name: "notes.txt",
      kind: "file",
      size_bytes: 5,
      mtime: 1700000000000,
    },
  });
  assert.equal(snake.bytesRead, 5);
  assert.equal(snake.sizeBytes, 5);
  assert.equal(snake.truncated, false);
  assert.equal(snake.entry.mtime, 1700000000000);

  const camel = sftp.normalizeSftpReadTextResponse({
    path: "/remote/notes.txt",
    content: "hello",
    offset: 0,
    bytesRead: 5,
    sizeBytes: 5,
    truncated: true,
  });
  assert.equal(camel.bytesRead, 5);
  assert.equal(camel.truncated, true);
  assert.equal(camel.entry, null);
});

test("terminal normalization accepts both host wire shapes", () => {
  const session = terminal.normalizeTerminalSession({
    id: "terminal-1",
    project_path_key: "/workspace",
    cwd: "/workspace",
    shell: "ssh",
    title: "Remote",
    kind: "ssh",
    pid: 99,
    cols: 120,
    rows: 40,
    created_at: 10,
    updated_at: 20,
    running: true,
    ssh: {
      host_id: "host-1",
      host_name: "example",
      username: "alice",
      host: "example.com",
      reconnect_max_attempts: 5,
      sftp_enabled: true,
    },
  });

  assert.equal(session.projectPathKey, "/workspace");
  assert.equal(session.pid, null);
  assert.equal(session.ssh.hostId, "host-1");
  assert.equal(session.ssh.reconnectMaxAttempts, 5);

  assert.deepEqual(
    terminal.normalizeTerminalShellOptions({
      shell_options: [
        { id: " zsh ", label: " Zsh ", command: " /bin/zsh " },
        { id: "", label: "Ignored", command: "" },
      ],
    }),
    {
      options: [{ id: "zsh", label: "Zsh", command: "/bin/zsh" }],
      defaultShell: "zsh",
    },
  );

  assert.deepEqual(
    terminal.normalizeTerminalSshLatency({
      session: { id: "terminal-1" },
      latency_ms: 12.6,
    }),
    { sessionId: "terminal-1", latencyMs: 13 },
  );
  assert.equal(terminal.normalizeOptionalOffset(8.9), 8);
  assert.equal(terminal.normalizeOptionalOffset(-1), undefined);
});

test("terminal tabs discard invalid wire records", () => {
  assert.deepEqual(
    terminal.normalizeSshTerminalTabsSnapshot({
      project_path_key: "/workspace",
      revision: 4,
      tabs: [
        {
          id: "tab-1",
          session_id: "terminal-1",
          project_path_key: "/workspace",
          kind: "sftp",
          created_at: 1,
          updated_at: 2,
        },
        { id: "tab-without-session", kind: "bash" },
      ],
    }),
    {
      projectPathKey: "/workspace",
      revision: 4,
      tabs: [
        {
          id: "tab-1",
          sessionId: "terminal-1",
          projectPathKey: "/workspace",
          kind: "sftp",
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    },
  );
});

test("terminal snapshots delegate host-specific byte decoding", () => {
  const calls = [];
  const snapshot = terminal.normalizeTerminalSnapshot(
    {
      session: { id: "terminal-1", project_path_key: "/workspace" },
      output: "fallback",
      output_bytes: "encoded",
      output_start_offset: 3.8,
      output_end_offset: 7,
    },
    (value, fallbackText) => {
      calls.push([value, fallbackText]);
      return Uint8Array.from([1, 2, 3]);
    },
  );

  assert.deepEqual(calls, [["encoded", "fallback"]]);
  assert.deepEqual([...snapshot.outputBytes], [1, 2, 3]);
  assert.equal(snapshot.outputStartOffset, 3);
  assert.equal(snapshot.outputEndOffset, 7);
});

test("terminal events accept an optional host extension normalizer", () => {
  const event = terminal.normalizeTerminalEvent(
    {
      kind: "ssh_local_forward",
      project_path_key: "/workspace",
      ssh_local_forward: { id: "forward-1" },
    },
    (input) => ({
      kind: "updated",
      forward: {
        id: input.id,
        sessionId: "terminal-1",
        projectPathKey: "/workspace",
        localHost: "127.0.0.1",
        localPort: 9000,
        address: "127.0.0.1:9000",
        remoteHost: "127.0.0.1",
        remotePort: 3000,
        status: "active",
        createdAt: 1,
        updatedAt: 2,
      },
      revision: 4,
    }),
  );

  assert.equal(event.sshLocalForward.forward.id, "forward-1");
  assert.equal(event.projectPathKey, "/workspace");
});
