#!/usr/bin/env node
// 门禁：settings 契约在收敛完成前的止血带（任务 #9）。
//
// 现状：crates/frontend/src/lib/settings/index.ts 是
// crates/core/src/settings/index.ts 的超集 —— 前端在共享逻辑之上追加了
// 纯 UI 符号（Theme 切换、RightDock 状态机、writerId 等），core 侧额外
// 持有 providerIdentities（CLI 身份，引擎独用）。两边没有任何同名函数
// 逻辑分叉，这个脚本的职责就是让"没有分叉"一直成立：
//
//   1. mcpOps.ts / normalize.ts 两边必须逐字节相同；
//   2. core 版 index.ts 的每一行（除下方白名单）必须按原顺序出现在
//      前端版里 —— 即 core 是前端的有序子序列。改共享逻辑只改一边、
//      或两边各自往同名函数里塞不同实现，都会在这里炸掉。
//
// 白名单只收 core 侧合法独有的行（import 路径差异、providerIdentities、
// transcript 宽度常量的注释与定义）。新增例外必须在这里登记并说明理由。
//
// 终态是消掉副本（core 持真相源、前端引用或镜像生成），见任务 #9 的
// 归类文档 docs/architecture/settings-convergence.md；到那天删掉本脚本。
//
// Usage: node scripts/check-settings-drift.mjs

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const corePath = (rel) => join(repoRoot, "crates", "core", "src", "settings", rel);
const frontendPath = (rel) => join(repoRoot, "crates", "frontend", "src", "lib", "settings", rel);

function fail(message) {
  console.error(`check-settings-drift: ${message}`);
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

// ---------------------------------------------------------------------------
// 1) 纯逻辑模块：必须逐字节一致。
// ---------------------------------------------------------------------------
for (const rel of ["mcpOps.ts", "normalize.ts"]) {
  if (read(corePath(rel)) !== read(frontendPath(rel))) {
    fail(
      `settings/${rel} 两侧不一致。这是共享逻辑模块，改动必须原样同步到` +
        "另一侧（crates/core 与 crates/frontend/src/lib 各一份）。",
    );
  }
}

// ---------------------------------------------------------------------------
// 2) index.ts：core 必须是前端的有序子序列（空行不参与匹配）。
// ---------------------------------------------------------------------------

// core 侧合法独有的行。每行都要能说清"为什么前端不需要它"。
const CORE_ONLY_LINES = new Set(
  [
    // import 路径差异：core 里 i18n/shared 的相对层级不同。
    'import { DEFAULT_LOCALE, type Locale, normalizeLocale } from "../i18n/config";',
    'import { normalizeFontFamily } from "../shared/fontFamily";',
    'export { normalizeFontFamily } from "../shared/fontFamily";',
    // CLI 身份：引擎独用（请求头/身份版本），前端不读不写，settings_load_all
    // 也不返回它 —— core 里恒为默认值,由 normalizeCliIdentitySettings 兜底。
    "import {",
    "  type CliIdentitySettings,",
    "  normalizeCliIdentitySettings,",
    '} from "../providers/cliIdentityCore";',
    "  providerIdentities: CliIdentitySettings;",
    "    providerIdentities: normalizeCliIdentitySettings(obj.providerIdentities),",
    // transcript 宽度边界：前端从 transcript-width 几何模块导入同值常量，
    // core 无 DOM 几何模块,就地定义。数值漂移会被下方 VALUE_GUARDS 抓住。
    "// Transcript width bounds enforced by normalizeChatTranscriptSettings below.",
    "export const DEFAULT_CHAT_TRANSCRIPT_WIDTH = 768;",
    "export const MIN_CHAT_TRANSCRIPT_WIDTH = 560;",
    "export const MAX_CHAT_TRANSCRIPT_WIDTH = 1200;",
  ].map((line) => line.trim()),
);

// transcript 宽度常量在前端真相源里的期望值：core 就地定义的数字与
// 前端 transcriptWidthModel 的定义必须一致。
const VALUE_GUARDS = [
  ["DEFAULT_CHAT_TRANSCRIPT_WIDTH = 768", "transcript-width/transcriptWidthModel.ts"],
  ["MIN_CHAT_TRANSCRIPT_WIDTH = 560", "transcript-width/transcriptWidthModel.ts"],
  ["MAX_CHAT_TRANSCRIPT_WIDTH = 1200", "transcript-width/transcriptWidthModel.ts"],
];
const widthModel = read(
  join(repoRoot, "crates", "frontend", "src", "lib", "transcript-width", "transcriptWidthModel.ts"),
);
for (const [snippet, where] of VALUE_GUARDS) {
  if (!widthModel.includes(snippet)) {
    fail(
      `前端 ${where} 里找不到 "${snippet}"。core 的就地常量与前端几何模块` +
        "的定义漂移了 —— 两边必须同值。",
    );
  }
}

const coreLines = read(corePath("index.ts")).split("\n");
const frontendLines = read(frontendPath("index.ts"))
  .split("\n")
  .map((line) => line.trim());

let cursor = 0;
const unmatched = [];
for (let i = 0; i < coreLines.length; i += 1) {
  const line = coreLines[i].trim();
  if (line === "") continue;
  if (CORE_ONLY_LINES.has(line)) continue;
  let found = -1;
  for (let j = cursor; j < frontendLines.length; j += 1) {
    if (frontendLines[j] === line) {
      found = j;
      break;
    }
  }
  if (found === -1) {
    unmatched.push({ lineNo: i + 1, text: coreLines[i] });
    if (unmatched.length >= 20) break;
  } else {
    cursor = found + 1;
  }
}

if (unmatched.length === 0) {
  console.log(
    "settings 契约未分叉：core 版是前端版的有序子序列" +
      "（providerIdentities 等已登记例外除外），mcpOps/normalize 逐字一致。",
  );
  process.exit(0);
}

console.error("check-settings-drift: settings/index.ts 共享逻辑分叉。");
console.error(`  core:   ${corePath("index.ts")}`);
console.error(`  前端:   ${frontendPath("index.ts")}`);
console.error("  以下 core 行在前端版里找不到（或顺序不符）：");
for (const { lineNo, text } of unmatched) {
  console.error(`    core:${lineNo}: ${text}`);
}
console.error(
  "修法：共享逻辑改动要同步两侧；core 侧合法独有的行登记进本脚本的" +
    " CORE_ONLY_LINES 并写明理由。",
);
process.exit(1);
