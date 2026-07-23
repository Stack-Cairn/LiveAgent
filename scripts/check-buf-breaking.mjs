#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const [gatewayDir, against] = process.argv.slice(2);
if (!gatewayDir || !against) {
  console.error("usage: check-buf-breaking.mjs <gateway-dir> <against>");
  process.exit(2);
}

// origin/main 上已经发布的 v2 帧壳曾引用 v1 包中的业务消息。本次删除 v1 时，
// 这些消息以相同字段号和 JSON 形状迁移到 v2 包。Buf 按全限定类型名报 breaking，
// 因此仅放行下列精确映射；任何字段号、字段名、外层消息或目标消息变化仍会失败。
const allowedPackageMigrations = new Map([
  ["WebClientFrame.3.agent_request", "GatewayEnvelope"],
  ["WebClientFrame.5.chat_command", "ChatCommandRequest"],
  ["WebServerFrame.3.agent_response", "AgentEnvelope"],
  ["WebServerFrame.4.local_error", "ErrorResponse"],
  ["WebServerFrame.20.history_event", "HistorySyncEvent"],
  ["WebServerFrame.21.settings_event", "SettingsSyncEvent"],
  ["WebServerFrame.22.terminal_event", "TerminalEvent"],
  ["WebServerFrame.23.sftp_event", "SftpEvent"],
  ["WebServerFrame.24.chat_queue_event", "ChatQueueEvent"],
  ["WebServerFrame.25.tunnel_state", "TunnelStateSnapshot"],
  ["WebServerFrame.26.process_state", "ManagedProcessSnapshot"],
  ["WebServerFrame.27.workspace_activity", "WorkspaceActivityEvent"],
  ["AgentClientFrame.2.envelope", "AgentEnvelope"],
  ["AgentServerFrame.2.envelope", "GatewayEnvelope"],
  ["TerminalClientFrame.2.frame", "TerminalStreamFrame"],
  ["TerminalServerFrame.2.frame", "TerminalStreamFrame"],
]);

const result = spawnSync(
  "buf",
  ["breaking", "--against", against, "--error-format", "json"],
  {
    cwd: resolve(process.cwd(), gatewayDir),
    encoding: "utf8",
  },
);

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
if (result.status === 0) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(0);
}

const lines = result.stdout.split(/\r?\n/u).filter(Boolean);
const unexpected = [];
let allowedCount = 0;
for (const line of lines) {
  let violation;
  try {
    violation = JSON.parse(line);
  } catch {
    unexpected.push(line);
    continue;
  }

  const match = /^Field "(\d+)" with name "([^"]+)" on message "([^"]+)" changed type from "liveagent\.gateway\.v1\.([^"]+)" to "liveagent\.gateway\.v2\.([^"]+)"\.$/u.exec(
    violation.message,
  );
  if (
    violation.path === "proto/v2/gateway_ws.proto" &&
    violation.type === "FIELD_WIRE_JSON_COMPATIBLE_TYPE" &&
    match
  ) {
    const [, fieldNumber, fieldName, messageName, oldType, newType] = match;
    const expectedType = allowedPackageMigrations.get(
      `${messageName}.${fieldNumber}.${fieldName}`,
    );
    if (expectedType === oldType && expectedType === newType) {
      allowedCount += 1;
      continue;
    }
  }
  unexpected.push(line);
}

if (
  unexpected.length === 0 &&
  allowedCount === allowedPackageMigrations.size &&
  !result.stderr
) {
  console.log(
    `buf breaking: accepted ${allowedCount} verified v1-to-v2 package-only field migrations`,
  );
  process.exit(0);
}

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (allowedCount !== 0 && allowedCount !== allowedPackageMigrations.size) {
  console.error(
    `buf breaking: matched ${allowedCount}/${allowedPackageMigrations.size} expected package migrations`,
  );
}
process.exit(result.status ?? 1);
