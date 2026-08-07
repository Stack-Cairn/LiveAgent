#!/usr/bin/env node
// 门禁：事件契约只有一份真相源（crates/core/src/protocol/wireEvents.ts），
// 前端那份是它的镜像。允许的差异只有两处，都在这里写死：
//   1. 文件头的镜像声明注释；
//   2. ToolStatus 联合末尾追加的前端本地 kind: "ui_stopping"。
//
// 校验方式不是"模糊归一化后对比"，而是：由 core 那份按上述两条规则算出
// 期望的前端文件，再与磁盘上的前端文件逐字比对。任何第三处差异都是漂移。
//
// Usage: node scripts/check-wire-events.mjs

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CORE_PATH = join(repoRoot, "crates", "core", "src", "protocol", "wireEvents.ts");
const FRONTEND_PATH = join(
  repoRoot,
  "crates",
  "frontend",
  "src",
  "lib",
  "protocol",
  "wireEvents.ts",
);

const FRONTEND_HEADER = `// 镜像 crates/core/src/protocol/wireEvents.ts（事件契约的唯一真相源在 core）。
// 前端只消费；除文末标注的前端本地 ui_stopping 外，此文件必须与 core 版逐字一致。
//
`;

// ToolStatus 联合的末尾（core 版）。
const UNION_TAIL = `      agent_name: string;
    };
`;

// 前端在同一位置的写法：收尾分号后移，中间插入本地 kind。
const UNION_TAIL_FRONTEND = `      agent_name: string;
    }
  /**
   * 前端本地状态：停止请求已发出、等待 run_ended。不上 wire，引擎侧永不产生；
   * 若 core 的停止流将来需要下发同类事实，应把这个 kind 上移到 core 的协议文件。
   */
  | { kind: "ui_stopping" };
`;

function fail(message) {
  console.error(`check-wire-events: ${message}`);
  process.exit(1);
}

function read(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    fail(`无法读取 ${path}: ${error?.message ?? error}`);
    return "";
  }
}

const core = read(CORE_PATH);
const frontend = read(FRONTEND_PATH);

const occurrences = core.split(UNION_TAIL).length - 1;
if (occurrences !== 1) {
  fail(
    `core 版里 ToolStatus 联合末尾锚点出现 ${occurrences} 次（期望 1 次）；` +
      "协议结构改了就同步改本脚本的锚点。",
  );
}

const expected = FRONTEND_HEADER + core.replace(UNION_TAIL, UNION_TAIL_FRONTEND);

if (expected === frontend) {
  console.log("wireEvents 契约一致：前端镜像与 core 逐字相符（仅 ui_stopping 例外）。");
  process.exit(0);
}

const expectedLines = expected.split("\n");
const actualLines = frontend.split("\n");
console.error("check-wire-events: 前端 wireEvents.ts 与 core 版漂移。");
console.error(`  真相源: ${CORE_PATH}`);
console.error(`  镜像:   ${FRONTEND_PATH}`);
let reported = 0;
for (let i = 0; i < Math.max(expectedLines.length, actualLines.length); i += 1) {
  if (expectedLines[i] === actualLines[i]) continue;
  if (reported >= 20) {
    console.error("  … 还有更多差异，已截断。");
    break;
  }
  console.error(`  第 ${i + 1} 行:`);
  console.error(`    期望: ${expectedLines[i] ?? "<文件结束>"}`);
  console.error(`    实际: ${actualLines[i] ?? "<文件结束>"}`);
  reported += 1;
}
console.error("修法：改 core 那份，再把改动原样搬到前端镜像（不要反向改）。");
process.exit(1);
