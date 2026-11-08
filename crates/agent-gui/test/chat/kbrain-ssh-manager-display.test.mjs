// K-brain's SSHManager in the transcript (Stack-Cairn/K-brain#181): short titles that name
// the action and the host, exec output and SFTP transfers as readable results, SSH login
// forms labelled as such, and the host-key question with its fingerprint on its own line.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const rootDir = fileURLToPath(new URL("../..", import.meta.url));
const requireFromRoot = createRequire(path.join(rootDir, "package.json"));
const jsxRuntime = requireFromRoot("react/jsx-runtime");
const { renderToStaticMarkup } = requireFromRoot("react-dom/server");

function NullIcon() {
  return null;
}

const plain = createTsModuleLoader({ rootDir });
const ssh = plain.loadModule("@liveagent/ui/lib/chat/sshManagerDisplay.ts");
const { getConciseToolTarget } = plain.loadModule(
  "@liveagent/ui/components/chat/assistant-bubble/conciseToolTarget.ts",
);
const utils = plain.loadModule(
  "@liveagent/ui/components/chat/assistant-bubble/assistantBubbleUtils.ts",
);
const IconSet = plain.loadModule("@liveagent/ui/components/IconSet.tsx");
const elicitation = plain.loadModule("@liveagent/ui/lib/chat/mcpElicitation.ts");

const rendering = createTsModuleLoader({
  rootDir,
  mocks: {
    "react/jsx-runtime": jsxRuntime,
    "@liveagent/ui/i18n/index": { useLocale: () => ({ t: (key) => key }) },
    "@liveagent/ui/components/IconSet": new Proxy({}, { get: () => NullIcon }),
  },
});
const resultView = rendering.loadModule(
  "@liveagent/ui/components/chat/assistant-bubble/SshManagerResult.tsx",
);
const elicitationCard = rendering.loadModule("@liveagent/ui/components/chat/McpElicitationCard.tsx");
const askCard = createTsModuleLoader({
  rootDir,
  mocks: {
    "react/jsx-runtime": jsxRuntime,
    "@liveagent/ui/i18n/index": { useLocale: () => ({ t: (key) => key }) },
    "@liveagent/ui/components/IconSet": new Proxy({}, { get: () => NullIcon }),
    // The slide-in panel reads window for reduced motion; render its children directly.
    "../MotionDirectionalPanel": { MotionDirectionalPanel: ({ children }) => children },
  },
}).loadModule("@liveagent/ui/components/chat/AskUserQuestionCard.tsx");

const HOST_ID = "6f1c2b0e-0000-4000-8000-000000000001";
const call = (args) => ({
  toolCall: { type: "toolCall", id: "ssh-1", name: "SSHManager", arguments: args },
});
const title = (args) => getConciseToolTarget(call(args));

test("SSHManager has its own activity category and server icon", () => {
  assert.equal(utils.getToolActivityCategory("SSHManager"), "ssh");
  assert.equal(utils.getToolMeta("SSHManager").Icon, IconSet.Server);
  assert.ok(utils.TOOL_ACTIVITY_CATEGORIES.includes("ssh"));
});

test("titles name the action and the host by its configured name", () => {
  ssh.rememberSshHostNames([{ id: HOST_ID, name: "web" }]);
  assert.equal(title({ action: "exec", host_id: HOST_ID, command: "uname -a" }).text, "exec on web: uname -a");
  assert.equal(
    title({ action: "sftp_upload", host_id: HOST_ID, local_path: "dist/app.tar", remote_path: "/srv/app.tar" }).text,
    "upload app.tar to web",
  );
  const upload = title({ action: "sftp_upload", host_id: HOST_ID, local_path: "dist/app.tar", remote_path: "/srv/app.tar" });
  assert.equal(upload.full, "upload dist/app.tar to web:/srv/app.tar");
  assert.equal(upload.lossy, true);
  assert.equal(
    title({ action: "sftp_download", host_id: HOST_ID, local_path: "logs", remote_path: "/var/log/syslog" }).text,
    "download syslog from web",
  );
  assert.equal(title({ action: "create_session", host_id: HOST_ID }).text, "connect to web");
  assert.equal(title({ action: "list_hosts" }).text, "list hosts");
  assert.equal(title({ action: "sftp_list", host_id: HOST_ID, path: "/etc" }).text, "list /etc on web");
  assert.equal(
    title({ action: "sftp_rename", host_id: HOST_ID, from_path: "/tmp/a.txt", to_path: "/tmp/b.txt" }).text,
    "rename a.txt to b.txt on web",
  );
  // A call on an existing session has no host_id; the title just omits the host.
  assert.equal(title({ action: "exec", session_id: "s-1", command: "ls" }).text, "exec: ls");
});

test("an unknown host id shows as is and long commands keep only their head", () => {
  ssh.rememberSshHostNames([]);
  assert.equal(title({ action: "exec", host_id: "db", command: "uptime" }).text, "exec on db: uptime");
  const long = title({
    action: "exec",
    host_id: "db",
    command: "cd /srv/app && for i in 1 2 3 4 5 6 7 8 9 10 11 12; do echo $i; sleep 1; done",
  });
  assert.ok(long.text.startsWith("exec on db: for i in"));
  assert.ok(long.text.endsWith("…"));
  assert.ok(long.full.includes("sleep 1; done"));
});

const EXEC_OUTPUT = [
  "session_id: s-1",
  "session_strategy: reuse_or_create",
  "session_reused: false",
  "session_created: true",
  "exit_code: 0",
  "timed_out: false",
  "",
  "stdout:",
  "Linux web 6.1.0 x86_64 GNU/Linux\n",
  "",
  "stderr:",
  "(empty)",
].join("\n");

test("exec output parses into exit code and streams", () => {
  const parsed = ssh.parseSshExecResult(EXEC_OUTPUT);
  assert.deepEqual(parsed, {
    exitCode: "0",
    timedOut: false,
    stdout: "Linux web 6.1.0 x86_64 GNU/Linux\n",
    stderr: "",
    sessionId: "s-1",
  });
  // stdout that itself contains a "stderr:" line is not cut there.
  const tricky = EXEC_OUTPUT.replace("Linux web", "a\n\nstderr:\nnot really\nLinux web");
  assert.match(ssh.parseSshExecResult(tricky).stdout, /not really/);
  assert.equal(ssh.parseSshExecResult("plain text"), null);
  assert.equal(ssh.hasSshManagerResultView("SSHManager", EXEC_OUTPUT, false), true);
  assert.equal(ssh.hasSshManagerResultView("SSHManager", EXEC_OUTPUT, true), false);
  assert.equal(ssh.hasSshManagerResultView("Bash", EXEC_OUTPUT, false), false);
});

test("exec output renders stdout as a code block and drops empty stderr", () => {
  const html = renderToStaticMarkup(resultView.getSshManagerResultView("SSHManager", EXEC_OUTPUT));
  assert.match(html, /data-ssh-result="exec"/);
  assert.match(html, /<pre[^>]*>Linux web 6\.1\.0 x86_64 GNU\/Linux<\/pre>/);
  assert.ok(html.includes(">stdout<"));
  assert.equal(html.includes(">stderr<"), false);
  assert.equal(html.includes("session_strategy"), false);
});

test("an SFTP transfer renders as a status line", () => {
  const text = JSON.stringify(
    {
      transfer: {
        id: "t-1",
        sessionId: "s-1",
        direction: "upload",
        status: "completed",
        sourcePath: "dist/app.tar",
        targetPath: "/srv/app.tar",
        currentPath: "",
        bytesDone: 2048,
        bytesTotal: 2048,
        filesDone: 1,
        filesTotal: 1,
      },
    },
    null,
    2,
  );
  const parsed = ssh.parseSshTransferResult(text);
  assert.equal(parsed.status, "completed");
  assert.equal(parsed.direction, "upload");
  const html = renderToStaticMarkup(resultView.getSshManagerResultView("SSHManager", text));
  assert.match(html, /data-ssh-result="transfer"/);
  assert.ok(html.includes("completed"));
  assert.ok(html.includes("2.0 KB / 2.0 KB"));
  assert.ok(html.includes("dist/app.tar → /srv/app.tar"));
  assert.equal(ssh.parseSshTransferResult('{"entries": []}'), null);
});

test("an SSH login form is labelled as an SSH login with the password masked", () => {
  const request = elicitation.parseMcpElicitationRequest({
    elicitation_id: "el-ssh",
    tool_call_id: "ssh-1",
    source: "ssh",
    server: "ssh:web",
    tool: "SSHManager",
    message: "SSHManager needs the password of web (alice@127.0.0.1:2222).",
    fields: [{ name: "password", type: "string", title: "Password", sensitive: true }],
  });
  assert.equal(request.source, "ssh");
  const html = renderToStaticMarkup(
    jsxRuntime.jsx(elicitationCard.McpElicitationForm, {
      request,
      interactive: true,
      onSubmit: async () => ({ ok: true }),
    }),
  );
  assert.match(html, /data-mcp-elicitation-source="ssh"/);
  assert.ok(html.includes("chat.mcpElicitation.sshLabel"));
  assert.equal(html.includes("chat.mcpElicitation.serverLabel"), false);
  assert.match(html, /data-mcp-elicitation-server="[^"]*"[^>]*>web</);
  assert.ok(html.includes("chat.mcpElicitation.sshSensitiveWarning"));
  assert.match(html, /<input[^>]*type="password"/);

  const record = elicitation.parseMcpElicitationRecord({
    source: "ssh",
    server: "ssh:web",
    message: "m",
    action: "accept",
    fields: [{ name: "password", type: "string", sensitive: true }],
    content: { password: "should-not-show" },
  });
  const summary = renderToStaticMarkup(
    jsxRuntime.jsx(elicitationCard.McpElicitationSummary, { record }),
  );
  assert.ok(summary.includes("chat.mcpElicitation.sshLabel"));
  assert.equal(summary.includes("should-not-show"), false);
});

test("a format: password field counts as sensitive", () => {
  const field = elicitation.parseMcpElicitationField({ name: "pin", type: "string", format: "password" });
  assert.equal(field.sensitive, true);
  assert.equal(field.format, undefined);
});

test("the host-key question shows the fingerprint on its own line and offers no free text", () => {
  const questions = [
    {
      id: "host_key",
      header: "SSH host key",
      prompt:
        "The SSH host web (127.0.0.1:2222) is not known yet.\n\nAlgorithm: ssh-ed25519\nFingerprint: SHA256:abc+def/123\n\nTrust this host key?",
      options: [
        { label: "Trust once" },
        { label: "Trust and save" },
        { label: "Reject", recommended: true },
      ],
    },
  ];
  const html = renderToStaticMarkup(
    jsxRuntime.jsx(askCard.AskUserQuestionCard, {
      questions,
      interactive: true,
      allowCustom: false,
      onSubmit: async () => ({ ok: true }),
    }),
  );
  assert.match(html, /data-question-field="Fingerprint"[\s\S]*?<code[^>]*>SHA256:abc\+def\/123<\/code>/);
  assert.match(html, /data-question-field="Algorithm"[\s\S]*?<code[^>]*>ssh-ed25519<\/code>/);
  assert.ok(html.includes("Trust this host key?"));
  assert.equal(html.includes("chat.askUser.customPlaceholder"), false);

  const withCustom = renderToStaticMarkup(
    jsxRuntime.jsx(askCard.AskUserQuestionCard, {
      questions,
      interactive: true,
      onSubmit: async () => ({ ok: true }),
    }),
  );
  assert.ok(withCustom.includes("chat.askUser.customPlaceholder"));
});
