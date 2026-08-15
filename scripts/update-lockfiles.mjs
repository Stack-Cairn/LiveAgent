#!/usr/bin/env node
/**
 * 一键更新仓库所有锁文件，使其与各 manifest 完全一致，从而通过 CI 的
 * `pnpm install --frozen-lockfile` 与 `cargo --locked` 校验。
 *
 *    pnpm-lock.yaml  ←  所有 package.json（pnpm 工作区，含 5 个项目）
 *    Cargo.lock      ←  Cargo.toml（Tauri 后端 workspace）
 *
 * 用法:
 *   node scripts/update-lockfiles.mjs            # 更新所有锁文件
 *   node scripts/update-lockfiles.mjs --check    # 仅校验是否一致，不写入
 *
 * pnpm 版本从根 package.json 的 packageManager 字段读取（与 CI 保持一致），
 * 通过 `npx pnpm@<version>` 调用，避免依赖全局 pnpm 版本。
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check");

/** 跨平台运行命令；Windows 下 npm/npx 以 .cmd 批处理形式存在，需经 shell 解析。 */
function run(name, args, { quiet = false } = {}) {
  const stdio = ["inherit", quiet ? "ignore" : "inherit", "inherit"];
  const res =
    process.platform === "win32"
      ? // 参数均为字面量（无空格 / 元字符），拼接后交给 shell 是安全的。
        spawnSync([name, ...args].join(" "), { cwd: root, stdio, shell: true })
      : spawnSync(name, args, { cwd: root, stdio });
  return res.status ?? 1;
}

// ── 1. pnpm 锁文件 ────────────────────────────────────────────────
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const [pmName, pnpmVersion] = (pkg.packageManager ?? "").split("@");
if (pmName !== "pnpm" || !pnpmVersion) {
  console.error(`无法从根 package.json#packageManager 解析 pnpm 版本: "${pkg.packageManager}"`);
  process.exit(1);
}

const pnpmArgs = ["--yes", `pnpm@${pnpmVersion}`, "install", "--lockfile-only"];
if (checkOnly) pnpmArgs.push("--frozen-lockfile");
console.log(`==> ${checkOnly ? "校验" : "更新"} pnpm-lock.yaml (pnpm@${pnpmVersion})`);
const pnpmStatus = run("npx", pnpmArgs);

// ── 2. Cargo 锁文件 ──────────────────────────────────────────────
// `cargo metadata` 不带 --locked 时会按 manifest 补齐 Cargo.lock，且保留已有版本；
// 带 --locked 时则在锁文件过期时直接报错（等价于 frozen 校验）。
// 注意不要用 `cargo generate-lockfile`：它会重新解析到「最新兼容版本」，造成大量无关升级。
const cargoArgs = checkOnly
  ? ["metadata", "--locked", "--format-version", "1"]
  : ["metadata", "--format-version", "1"];
console.log(`==> ${checkOnly ? "校验" : "更新"} Cargo.lock`);
const cargoStatus = run("cargo", cargoArgs, { quiet: true });

// ── 汇总 ─────────────────────────────────────────────────────────
if (pnpmStatus !== 0 || cargoStatus !== 0) {
  console.error(`\n锁文件${checkOnly ? "与 manifest 不一致" : "更新失败"}（pnpm=${pnpmStatus}, cargo=${cargoStatus}）。`);
  process.exit(1);
}
console.log(`\n所有锁文件已${checkOnly ? "与 manifest 一致" : "更新完成"}。`);
