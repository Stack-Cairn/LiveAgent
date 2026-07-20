import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const policyModule = loader.loadModule("src/lib/chat/runner/toolApprovalPolicy.ts");
const {
  assessDangerousToolCall,
  buildApprovalDeniedText,
  buildUnattendedDenialText,
  isLikelyExternalCwd,
} = policyModule;

const POLICY = { mode: "dangerous", workdir: "C:\\Users\\me\\repo" };
const OFF_POLICY = { mode: "off", workdir: "C:\\Users\\me\\repo" };

function toolCall(name, args = {}) {
  return { type: "toolCall", id: "tc-1", name, arguments: args };
}

test("policy off never flags anything", () => {
  assert.equal(assessDangerousToolCall(OFF_POLICY, toolCall("Delete", { path: "src" })), null);
  assert.equal(
    assessDangerousToolCall(OFF_POLICY, toolCall("Bash", { command: "rm -rf /", cwd: "/" })),
    null,
  );
});

test("Delete always requires approval under the dangerous policy", () => {
  const assessment = assessDangerousToolCall(POLICY, toolCall("Delete", { path: "src/app.ts" }));
  assert.equal(assessment?.kind, "delete");
  assert.equal(assessment?.detail, "src/app.ts");
});

test("SSHManager mutating actions require approval, read-only ones do not", () => {
  const exec = assessDangerousToolCall(
    POLICY,
    toolCall("SSHManager", { action: "exec", command: "systemctl restart app" }),
  );
  assert.equal(exec?.kind, "ssh-mutation");
  assert.match(exec?.detail ?? "", /systemctl restart app/);

  for (const action of ["sftp_delete", "sftp_upload", "sftp_write_text", "send_input"]) {
    assert.equal(
      assessDangerousToolCall(POLICY, toolCall("SSHManager", { action }))?.kind,
      "ssh-mutation",
      `${action} should require approval`,
    );
  }

  for (const action of ["list_hosts", "list_sessions", "read_session", "sftp_list", "sftp_stat"]) {
    assert.equal(
      assessDangerousToolCall(POLICY, toolCall("SSHManager", { action })),
      null,
      `${action} should not require approval`,
    );
  }
});

test("Bash with an external cwd requires approval; workspace cwd does not", () => {
  const external = assessDangerousToolCall(
    POLICY,
    toolCall("Bash", { command: "dir", cwd: "C:\\Windows\\System32" }),
  );
  assert.equal(external?.kind, "external-cwd");
  assert.match(external?.detail ?? "", /System32/);

  assert.equal(
    assessDangerousToolCall(POLICY, toolCall("Bash", { command: "dir", cwd: "src" })),
    null,
  );
  assert.equal(
    assessDangerousToolCall(POLICY, toolCall("Bash", { command: "dir" })),
    null,
    "no cwd means workspace root",
  );
  assert.equal(
    assessDangerousToolCall(
      POLICY,
      toolCall("ManagedProcess", { action: "start", command: "vite", cwd: "/etc" }),
    )?.kind,
    "external-cwd",
  );
});

test("isLikelyExternalCwd covers separators, case, home, parent-escapes, and skills", () => {
  const workdir = "C:\\Users\\me\\repo";
  assert.equal(isLikelyExternalCwd("C:/Users/ME/repo/src", workdir), false);
  assert.equal(isLikelyExternalCwd("C:\\Users\\me\\repo", workdir), false);
  assert.equal(isLikelyExternalCwd("C:\\Users\\me\\repository", workdir), true);
  assert.equal(isLikelyExternalCwd("D:/other", workdir), true);
  assert.equal(isLikelyExternalCwd("/etc", workdir), true);
  assert.equal(isLikelyExternalCwd("~/Downloads", workdir), true);
  assert.equal(isLikelyExternalCwd("file:///tmp", workdir), true);
  assert.equal(isLikelyExternalCwd("../outside", workdir), true);
  assert.equal(isLikelyExternalCwd("src/../lib", workdir), true);
  assert.equal(isLikelyExternalCwd("skill://helper/scripts", workdir), false);
  assert.equal(isLikelyExternalCwd(undefined, workdir), false);
  assert.equal(isLikelyExternalCwd("", workdir), false);
});

test("denial texts teach the model instead of inviting retries", () => {
  const call = toolCall("Delete", { path: "src" });
  const assessment = { kind: "delete", detail: "src" };
  assert.match(buildApprovalDeniedText(call, assessment), /declined/);
  assert.match(buildApprovalDeniedText(call, assessment), /Do not retry/);
  assert.match(buildUnattendedDenialText(call, assessment), /approval policy/);
  assert.match(buildUnattendedDenialText(call, assessment), /remote or delegated/);
});

test("long details are truncated", () => {
  const assessment = assessDangerousToolCall(
    POLICY,
    toolCall("Delete", { path: "x".repeat(500) }),
  );
  assert.ok((assessment?.detail.length ?? 0) <= 201);
});
