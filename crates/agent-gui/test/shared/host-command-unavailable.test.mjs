import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { isHostCommandUnavailable, hostAwareErrorMessage } = loader.loadModule(
  "../agent-ui/src/lib/shared/hostErrors.ts",
);

test("recognises both hosts that lack a desktop command", () => {
  assert.equal(
    isHostCommandUnavailable(
      new Error("Tauri command terminal_create is unavailable in K-brain browser mode"),
    ),
    true,
  );
  assert.equal(
    isHostCommandUnavailable(new Error("Desktop runtime command checkpoint_list is unavailable in K-brain mode; use the K-brain backend capability.")),
    true,
  );
  assert.equal(
    isHostCommandUnavailable('WebUI shim does not implement invoke("git_branches")'),
    true,
  );
});

test("real failures keep passing through", () => {
  assert.equal(isHostCommandUnavailable(new Error("git: not a repository")), false);
  assert.equal(isHostCommandUnavailable(new Error("permission denied")), false);
  assert.equal(isHostCommandUnavailable(undefined), false);
  assert.equal(isHostCommandUnavailable(null), false);
});

test("hostAwareErrorMessage swaps host diagnostics for the localised reason", () => {
  assert.equal(
    hostAwareErrorMessage(
      new Error("Tauri command fs_list is unavailable in K-brain browser mode"),
      "本地化提示",
    ),
    "本地化提示",
  );
  assert.equal(
    hostAwareErrorMessage('WebUI shim does not implement invoke("git_branches")', "本地化提示"),
    "本地化提示",
  );
  // 真实失败原样透出，空消息才回落 fallback。
  assert.equal(hostAwareErrorMessage(new Error("permission denied"), "本地化提示"), "permission denied");
  assert.equal(hostAwareErrorMessage(new Error(""), "本地化提示", "兜底"), "兜底");
  assert.equal(hostAwareErrorMessage(undefined, "本地化提示", "兜底"), "兜底");
});

test("project tool surfaces route errors through the host-aware helper", () => {
  const dockSessions = readFileSync(
    new URL("../../../agent-ui/src/components/project-tools/useRightDockSessions.ts", import.meta.url),
    "utf8",
  );
  // 终端 tile 的失败文案不再直接落原始 Tauri 诊断。
  assert.match(dockSessions, /setError\(hostAwareErrorMessage\(err, t\("projectTools\.runtimeUnsupported"\)\)\)/);
  assert.equal(/setError\(err instanceof Error \? err\.message/.test(dockSessions), false);

  const fileTreeModel = readFileSync(
    new URL("../../../agent-ui/src/components/project-tools/file-tree/model.ts", import.meta.url),
    "utf8",
  );
  assert.match(fileTreeModel, /if \(isHostCommandUnavailable\(error\)\) return fallback;/);

  const sshPanel = readFileSync(
    new URL("../../../agent-ui/src/components/project-tools/SshTunnelPanel.tsx", import.meta.url),
    "utf8",
  );
  assert.match(sshPanel, /function errorMessage\(error: unknown, unavailableMessage = ""\)/);
  assert.match(sshPanel, /hostAwareErrorMessage\(error, unavailableMessage\)/);
});

test("branch selector swaps the host message for a localised hint", () => {
  const source = readFileSync(
    new URL("../../../agent-ui/src/components/git/GitBranchSelector.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /isHostCommandUnavailable\(err\)/);
  assert.match(source, /"git\.branchSelector\.runtimeUnsupported"/);

  const zh = readFileSync(
    new URL("../../../agent-ui/src/i18n/translations/zhCNCommon.ts", import.meta.url),
    "utf8",
  );
  const en = readFileSync(
    new URL("../../../agent-ui/src/i18n/translations/enUSCommon.ts", import.meta.url),
    "utf8",
  );
  assert.match(zh, /"git\.branchSelector\.runtimeUnsupported":\s*\n?\s*"[^"]*桌面 Git 能力/);
  assert.match(en, /"git\.branchSelector\.runtimeUnsupported":\s*\n?\s*"[^"]*desktop Git/);
});

test("settings surfaces swap host diagnostics for a desktop-only hint", () => {
  const about = readFileSync(
    new URL("../../src/pages/settings/AboutSection.tsx", import.meta.url),
    "utf8",
  );
  assert.match(about, /hostAwareErrorMessage\(error, t\("settings\.aboutDesktopHostRequired"\)\)/);
  assert.equal(/function errorMessage\(error: unknown\)/.test(about), false);

  const backup = readFileSync(
    new URL("../../src/pages/settings/BackupSyncSection.tsx", import.meta.url),
    "utf8",
  );
  assert.match(backup, /function errorText\(error: unknown, unavailableMessage: string\)/);
  assert.match(backup, /hostAwareErrorMessage\(error, unavailableMessage\)/);
  assert.match(backup, /errorText\(error, t\("settings\.backupSyncDesktopHostRequired"\)\)/);

  const ssh = readFileSync(
    new URL("../../../agent-ui/src/pages/settings/SshSection.tsx", import.meta.url),
    "utf8",
  );
  assert.match(ssh, /hostAwareErrorMessage\(scanError, t\("settings\.sshImportDesktopHostRequired"\)\)/);
});

test("settings desktop-only hints exist in both locales", () => {
  // GUI overrides carry both locales in one module; assert each locale's copy separately.
  const guiConfig = readFileSync(new URL("../../src/i18n/config.ts", import.meta.url), "utf8");
  assert.match(guiConfig, /"settings\.aboutDesktopHostRequired":\s*\n?\s*"[^"]*桌面应用/);
  assert.match(guiConfig, /"settings\.backupSyncDesktopHostRequired":\s*\n?\s*"[^"]*桌面应用/);
  assert.match(
    guiConfig,
    /"settings\.aboutDesktopHostRequired":\s*\n?\s*"Updates and update announcements are provided by the desktop app/,
  );

  const zhSettings = readFileSync(
    new URL("../../../agent-ui/src/i18n/translations/zhCNSettings.ts", import.meta.url),
    "utf8",
  );
  const enSettings = readFileSync(
    new URL("../../../agent-ui/src/i18n/translations/enUSSettings.ts", import.meta.url),
    "utf8",
  );
  assert.match(zhSettings, /"settings\.sshImportDesktopHostRequired":\s*\n?\s*"[^"]*桌面应用/);
  assert.match(enSettings, /"settings\.sshImportDesktopHostRequired":\s*\n?\s*"[^"]*desktop/);
});
