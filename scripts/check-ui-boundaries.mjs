#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");

function listSourceFiles(root, directory = root) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const absolutePath = join(directory, entry);
    if (statSync(absolutePath).isDirectory()) {
      files.push(...listSourceFiles(root, absolutePath));
    } else if (/\.(?:ts|tsx)$/.test(entry)) {
      files.push(absolutePath);
    }
  }
  return files;
}

const checks = [
  {
    root: join(repoRoot, "crates/agent-ui/src"),
    forbidden: [
      { pattern: /(?:from\s+|import\s*\(\s*|import\s+)["']@tauri-apps\//, reason: "共享层必须通过 @liveagent/adapters 访问应用能力" },
      { pattern: /(?:from\s+|import\s*\(\s*)["'][^"']*crates\/agent-(?:gui|gateway)/, reason: "共享层不能反向依赖具体应用路径" },
    ],
  },
  {
    root: join(repoRoot, "crates/agent-gateway/web/src"),
    forbidden: [
      { pattern: /(?:from\s+|import\s*\(\s*|import\s+)["']@tauri-apps\//, reason: "WebUI 不能直接导入 Tauri API" },
      { pattern: /(?:from\s+|import\s*\(\s*)["'][^"']*crates\/agent-gui/, reason: "WebUI 不能依赖桌面应用源码" },
      {
        pattern: /(?:from\s+|import\s*\(\s*|import\s+)["'](?:@\/|\.{1,2}\/)[^"']*ChatComposerBar["']/,
        reason: "聊天输入栏必须使用 @liveagent/ui/pages/chat/ChatComposerBar",
      },
      {
        pattern: /chat-(?:user-bubble|assistant)-action/,
        reason: "消息操作栏必须使用 @liveagent/ui/components/chat/TranscriptMessageActions",
      },
      {
        pattern:
          /(?:from\s+|import\s*\(\s*|import\s+)["']@liveagent\/ui\/(?:components\/chat\/ChatHeader|pages\/(?:skills-hub\/SkillsHubPage|mcp-hub\/McpHubPage))["']/,
        reason: "公共页面与聊天顶部栏必须由共享 ApplicationView 统一组装",
      },
      {
        pattern:
          /(?:from\s+|import\s*\(\s*|import\s+)["']@\/pages\/chat\/(?:AssistantBubble|useChatSkills|queue\/chatTurnQueue|assistant-bubble\/[^"']+)["']/,
        reason: "聊天渲染、Skill 与队列公共逻辑必须使用 agent-ui 共享实现",
      },
      {
        pattern:
          /(?:from\s+|import\s*\(\s*|import\s+)["']\.\/(?:FileDropOverlay|WorkspaceOverlayHost)["']/,
        reason: "聊天 Overlay 必须使用 agent-ui 共享实现",
      },
    ],
  },
  {
    root: join(repoRoot, "crates/agent-gui/src"),
    forbidden: [
      { pattern: /(?:from\s+|import\s*\(\s*)["'][^"']*crates\/agent-gateway\/web/, reason: "GUI 不能依赖 WebUI 应用源码" },
      {
        pattern: /(?:from\s+|import\s*\(\s*|import\s+)["']\.{1,2}\/[^"']*ChatComposerBar["']/,
        reason: "聊天输入栏必须使用 @liveagent/ui/pages/chat/ChatComposerBar",
      },
      {
        pattern: /chat-(?:user-bubble|assistant)-action/,
        reason: "消息操作栏必须使用 @liveagent/ui/components/chat/TranscriptMessageActions",
      },
      {
        pattern:
          /(?:from\s+|import\s*\(\s*|import\s+)["']@liveagent\/ui\/(?:components\/chat\/ChatHeader|pages\/(?:skills-hub\/SkillsHubPage|mcp-hub\/McpHubPage))["']/,
        reason: "公共页面与聊天顶部栏必须由共享 ApplicationView 统一组装",
      },
      {
        pattern:
          /(?:from\s+|import\s*\(\s*|import\s+)["']\.{1,2}\/(?:components\/(?:ChatFileDropOverlay|WorkspaceOverlayHost|assistant-bubble\/[^"']+)|hooks\/useChatSkills)["']/,
        reason: "聊天渲染、Overlay 与 Skill 公共逻辑必须使用 agent-ui 共享实现",
      },
    ],
  },
];

let failures = 0;
for (const check of checks) {
  for (const file of listSourceFiles(check.root)) {
    const source = readFileSync(file, "utf8");
    for (const rule of check.forbidden) {
      if (!rule.pattern.test(source)) continue;
      failures += 1;
      console.error(`${relative(repoRoot, file)}: ${rule.reason}`);
    }
  }
}

const sharedRoot = join(repoRoot, "crates/agent-ui/src");
const appRoots = [
  join(repoRoot, "crates/agent-gui/src"),
  join(repoRoot, "crates/agent-gateway/web/src"),
];
for (const sharedFile of listSourceFiles(sharedRoot)) {
  const sharedRelativePath = relative(sharedRoot, sharedFile);
  for (const appRoot of appRoots) {
    if (!existsSync(join(appRoot, sharedRelativePath))) continue;
    failures += 1;
    console.error(
      `${relative(repoRoot, appRoot)}/${sharedRelativePath}: 共享源码不能在应用目录保留同路径副本`,
    );
  }
}

const retiredSharedCopies = [
  "crates/agent-gui/src/pages/chat/components/ChatFileDropOverlay.tsx",
  "crates/agent-gui/src/pages/chat/components/WorkspaceOverlayHost.tsx",
  "crates/agent-gui/src/pages/chat/components/assistant-bubble/RoundContent.tsx",
  "crates/agent-gui/src/pages/chat/components/assistant-bubble/ToolCallItem.tsx",
  "crates/agent-gui/src/pages/chat/components/assistant-bubble/ToolImages.tsx",
  "crates/agent-gui/src/pages/chat/components/assistant-bubble/ToolResultDisplay.tsx",
  "crates/agent-gui/src/pages/chat/components/assistant-bubble/ToolTraceGroup.tsx",
  "crates/agent-gui/src/pages/chat/components/assistant-bubble/assistantBubbleUtils.ts",
  "crates/agent-gui/src/pages/chat/hooks/useChatSkills.ts",
  "crates/agent-gateway/web/src/app/FileDropOverlay.tsx",
  "crates/agent-gateway/web/src/app/WorkspaceOverlayHost.tsx",
  "crates/agent-gateway/web/src/pages/chat/AssistantBubble.tsx",
  "crates/agent-gateway/web/src/pages/chat/assistant-bubble/RoundContent.tsx",
  "crates/agent-gateway/web/src/pages/chat/assistant-bubble/ToolCallItem.tsx",
  "crates/agent-gateway/web/src/pages/chat/assistant-bubble/ToolImages.tsx",
  "crates/agent-gateway/web/src/pages/chat/assistant-bubble/ToolResultDisplay.tsx",
  "crates/agent-gateway/web/src/pages/chat/assistant-bubble/ToolTraceGroup.tsx",
  "crates/agent-gateway/web/src/pages/chat/assistant-bubble/assistantBubbleUtils.ts",
  "crates/agent-gateway/web/src/pages/chat/queue/chatTurnQueue.ts",
  "crates/agent-gateway/web/src/pages/chat/useChatSkills.ts",
];
for (const retiredPath of retiredSharedCopies) {
  if (!existsSync(join(repoRoot, retiredPath))) continue;
  failures += 1;
  console.error(`${retiredPath}: 已迁移到 agent-ui 的共享源码不能在宿主目录重新创建`);
}

const applicationEntries = [
  join(repoRoot, "crates/agent-gui/src/pages/ChatPage.tsx"),
  join(repoRoot, "crates/agent-gateway/web/src/app/GatewayApp.tsx"),
];
for (const appFile of applicationEntries) {
  const source = readFileSync(appFile, "utf8");
  if (source.includes("@liveagent/ui/application/ApplicationView")) continue;
  failures += 1;
  console.error(
    `${relative(repoRoot, appFile)}: 应用必须通过共享 ApplicationView 渲染主视图`,
  );
}

if (failures > 0) process.exit(1);
console.log("UI boundary check passed.");
