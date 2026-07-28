import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader({
  mocks: {
    "@streamdown/cjk": {
      cjk: {},
    },
    "@streamdown/code": {
      code: {},
    },
    "@streamdown/math": {
      math: {},
    },
    "@streamdown/mermaid": {
      mermaid: {},
    },
    streamdown: {
      Streamdown(props) {
        return { type: "Streamdown", props };
      },
      defaultRemarkPlugins: {},
      defaultRehypePlugins: {},
    },
    "@tauri-apps/plugin-opener": {
      openUrl() {
        throw new Error("openUrl mock was not expected to be called");
      },
    },
    "react-dom": {
      createPortal(children, container) {
        return { type: "portal", children, container };
      },
    },
    "./ui/button": {
      Button(props) {
        return { type: "Button", props };
      },
    },
    "../lib/shared/utils": {
      cn: (...parts) => parts.filter(Boolean).join(" "),
    },
    "../lib/shared/modalMotion": {
      useModalMotion(onClose) {
        return { modalState: "open", requestClose: onClose };
      },
    },
    "@earendil-works/pi-agent-core": {
      Agent: class Agent {},
    },
    "../providers/llm": {
      buildProviderRequestMetadata() {},
      createModelFromConfig() {},
      finalizeProviderStreamOptions() {},
      normalizeErrorMessage(message, fallback) {
        return message || fallback;
      },
      resolveProviderCacheRetention() {},
      toSimpleStreamReasoning(value) {
        return value;
      },
      streamSimpleByApi() {
        throw new Error("streamSimpleByApi mock was not expected to be called");
      },
      buildDualAuthHeaders() {
        return {};
      },
      createStreamingTextReconciler() {
        return {};
      },
    },
    "../debug/agentDebug": {
      buildStreamRequestDebugPayload() {
        return {};
      },
    },
    "../system/powerActivity": {
      withPowerActivity(task) {
        return task;
      },
    },
    "../providers/proxy": {
      prepareProxyRequest() {
        return {};
      },
    },
    "./uiMessages": {
      summarizeToolCall() {
        return "";
      },
    },
    "./seedToolCalls": {
      recoverAssistantSeedToolCalls() {
        return null;
      },
    },
    "./requestContextSanitizer": {
      sanitizeContextForModelRequest(context) {
        return context;
      },
    },
  },
});

const markdownModule = loader.loadModule("src/components/Markdown.tsx");
const agentRunnerModule = loader.loadModule("src/lib/chat/runner/agentRunner.ts");

test("markdown image syntax falls back to alt text instead of rendering a real image", () => {
  const node = markdownModule.markdownComponents.img({
    alt: "东门老街",
    title: "深圳夜景",
  });

  assert.ok(node);
  assert.equal(node.type, "span");
  assert.equal(node.props["data-liveagent-markdown-image"], "text-fallback");
  assert.equal(node.props.title, "东门老街");
  assert.equal(node.props.children, "东门老街");

  const titleOnly = markdownModule.markdownComponents.img({ title: "南头古城" });
  assert.ok(titleOnly);
  assert.equal(titleOnly.props.children, "南头古城");

  const empty = markdownModule.markdownComponents.img({});
  assert.equal(empty, null);
});

test("external link safety modal renders through document body portal", () => {
  const previousDocument = globalThis.document;
  const body = { nodeType: 1 };
  globalThis.document = { body };

  try {
    const portal = markdownModule.ExternalLinkModal({
      isOpen: true,
      onClose() {},
      onConfirm() {},
      url: "https://example.com/dashboard",
    });

    assert.ok(portal);
    assert.equal(portal.type, "portal");
    assert.equal(portal.container, body);
    assert.equal(portal.children.type, "div");
    assert.match(portal.children.props.className, /\bfixed\b/);
    assert.match(portal.children.props.className, /\binset-0\b/);
  } finally {
    if (typeof previousDocument === "undefined") {
      delete globalThis.document;
    } else {
      globalThis.document = previousDocument;
    }
  }
});

test("agent tool rules require Image for chat-visible images", () => {
  const suffix = agentRunnerModule.buildToolsSuffix("/workspace");
  assert.match(suffix, /To display any image in the chat UI, call the Image tool\./);
  assert.match(
    suffix,
    /Do not embed images with Markdown syntax like !\[alt\]\(path\), HTML <img>, file:\/\/ URLs, or local relative image paths in your final text\./,
  );
  assert.match(
    suffix,
    /Local image: pass `path` exactly as seen, including workspace-relative, absolute, or skill:\/\/ paths\./,
  );
  assert.match(
    suffix,
    /Do not use Bash, open, xdg-open, Markdown, or HTML to display Skill images\./,
  );
  assert.match(
    suffix,
    /For remote images, call Image with url\/urls or source\/sources directly instead of downloading them, unless the user explicitly asks to save the file locally\./,
  );
  assert.match(
    suffix,
    /If another tool saves, downloads, screenshots, generates, or returns an image file path or image URL and the user should see it, call Image with that path or URL before the final response\./,
  );
  assert.match(
    suffix,
    /Final text may describe or caption images already displayed by Image, but must not attempt to render images directly\./,
  );
});

test("agent tool rules prefer one parallel Agent batch over sequential calls", () => {
  const suffix = agentRunnerModule.buildToolsSuffix("/workspace", [
    "Agent",
    "Read",
    "Write",
    "Bash",
  ]);
  assert.match(suffix, /issue ONE Agent call whose `agents` array lists every job/);
  assert.match(
    suffix,
    /Use sequential Agent calls only when a later job needs an earlier job's output/,
  );
  assert.match(suffix, /Default to mode=readonly for research, review, and discussion agents/);
  assert.match(
    suffix,
    /call Agent again with the same stable id\(s\) and only the new prompt/,
  );
  assert.match(suffix, /If an Agent call is rejected, no subagents were started/);
});

test("SendMessage tool rules explain parent-private visibility", () => {
  const suffix = agentRunnerModule.buildToolsSuffix("/workspace", [
    "Agent",
    "SendMessage",
    "Read",
  ]);
  assert.match(suffix, /Messages sent to parent are private to the parent/);
  assert.match(suffix, /send to=\* when peer agents need to read a report or summary/);
  assert.match(suffix, /Message delivery is deferred to the next model turn boundary/);
});

test("agent tool rules keep local file discovery on file tools instead of Bash", () => {
  const suffix = agentRunnerModule.buildToolsSuffix("/workspace", [
    "Read",
    "List",
    "Glob",
    "Grep",
    "Bash",
    "SkillsManager",
  ]);
  assert.match(suffix, /Preferred form: workspace-relative paths exactly as tools return them/);
  assert.match(suffix, /For files inside a Skill, call file tools with a path like `skill:\/\/<baseDir>\/references\/guide\.md`/);
  assert.match(suffix, /Do not run Bash cat\/ls\/find\/grep/);
});

test("agent tool rules steer new files to concrete Write paths", () => {
  const suffix = agentRunnerModule.buildToolsSuffix("/workspace", [
    "Read",
    "Write",
    "Edit",
    "Bash",
  ]);
  assert.match(suffix, /New files: call Write with a file path that includes the filename and the full content/);
  assert.match(suffix, /parent directories are created automatically/);
  assert.match(suffix, /Write and Edit check the file's current on-disk state automatically/);
  assert.match(suffix, /path must include the intended filename, not just a directory/);
  assert.match(suffix, /write \/ create files via heredocs, `tee`, `touch`, `cp`, or `mkdir`/);
});

test("agent tool rules keep workspace and Skills deletion on Delete", () => {
  const suffix = agentRunnerModule.buildToolsSuffix("/workspace", [
    "Delete",
    "Bash",
    "ManagedProcess",
    "SkillsManager",
  ]);
  assert.match(suffix, /Every intentional deletion[\s\S]*MUST use Delete/);
  assert.match(suffix, /NEVER perform such a deletion through Bash, ManagedProcess/);
  assert.match(suffix, /`git rm`, `git clean`, PowerShell `Remove-Item`/);
  assert.match(suffix, /cmd `del` \/ `erase` \/ `rd`/);
  assert.match(suffix, /record the path in Edited Files and the file ledger/);
  assert.match(
    suffix,
    /stage only that path[\s\S]*`git add -u -- <exact-workspace-relative-path>`/,
  );
});

test("agent tool rules route installed Skill scripts through skill cwd", () => {
  const suffix = agentRunnerModule.buildToolsSuffix("/workspace", [
    "Bash",
    "SkillsManager",
    "Read",
    "List",
    "Glob",
  ]);
  assert.match(suffix, /Bash\.cwd follows the path rules in \*\*Workspace & Paths\*\*/);
  assert.match(suffix, /use cwd="skill:\/\/<enabled-skill>\/scripts"/);
  assert.match(suffix, /Do not cd into ~\/\.liveagent\/skills or workspace skills\/ guesses/);
});

test("agent Bash rules are Git Bash-first when runtime platform is Windows", () => {
  const suffix = agentRunnerModule.buildToolsSuffix(
    "/workspace",
    ["Bash", "ManagedProcess"],
    "windows",
  );
  assert.match(suffix, /Current platform: Windows/);
  assert.match(suffix, /Git Bash with POSIX semantics/);
  assert.match(suffix, /Write POSIX\/bash-compatible commands by default/);
  assert.match(suffix, /shell_family: powershell/);
  assert.match(suffix, /require `nohup` and log redirection/);
});

test("fs tool descriptions keep Image as the only display path for images", () => {
  const sourcePath = fileURLToPath(new URL("../../src/lib/tools/fsTools.ts", import.meta.url));
  const source = fs.readFileSync(sourcePath, "utf8");

  assert.match(
    source,
    /Use Image instead when the user asks to show, view, render, or display an image in the chat UI\. Do not use Markdown image syntax or HTML img tags to display files\./,
  );
  assert.match(
    source,
    /This is the only supported way for assistant-side image rendering\./,
  );
  assert.match(
    source,
    /Supports workspace paths, enabled Skill paths, external absolute paths, http\/https URLs, base64 data URLs, and SVG images/,
  );
  assert.match(
    source,
    /For remote images, pass url\/urls or source\/sources directly instead of downloading the image first, unless the user explicitly asks to save it locally\./,
  );
  assert.match(
    source,
    /Multiple mixed image sources to display in order\. Use this for mixed path \+ URL \+ base64 galleries\./,
  );
  assert.match(
    source,
    /Do not embed images in final text with Markdown image syntax, HTML img tags, file:\/\/ URLs, or local relative image paths\./,
  );
  assert.match(
    source,
    /The structured, tracked way to intentionally delete a workspace or enabled Skill file\/directory/,
  );
  assert.match(source, /Delete results feed LiveAgent's Edited Files and file-ledger tracking/);
});
