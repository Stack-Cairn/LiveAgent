import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// Every plugin panel, MCP App view and HTML preview renders through SandboxedFrame, whose
// sandbox is exactly "allow-scripts": no same-origin access, popups, forms or navigation.
const loader = createTsModuleLoader({ mocks: { "react/jsx-runtime": jsxRuntime } });
const { SandboxedFrame } = loader.loadModule("@liveagent/ui/components/sandboxed-ui/SandboxedFrame.tsx");

const repoCrates = fileURLToPath(new URL("../../..", import.meta.url));
const SOURCE_ROOTS = ["agent-ui/src", "agent-gui/src", "agent-gateway/web/src"].map((dir) => path.join(repoCrates, dir));

function* sourceFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") yield* sourceFiles(full);
    } else if (/\.(tsx?|mjs|js)$/.test(entry.name)) {
      yield full;
    }
  }
}

function attributes(markup) {
  const tag = markup.match(/<iframe\b[^>]*>/)?.[0] ?? "";
  return Object.fromEntries([...tag.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)].map((match) => [match[1].toLowerCase(), match[2]]));
}

test("SandboxedFrame renders sandbox=allow-scripts and no referrer, for src and srcdoc", () => {
  for (const props of [
    { title: "Panel", src: "http://127.0.0.1:7777/v1/plugins/x/ui/board/index.html?t=cap" },
    { title: "App", srcDoc: "<!doctype html><p>view</p>" },
  ]) {
    const attrs = attributes(renderToStaticMarkup(jsxRuntime.jsx(SandboxedFrame, props)));
    assert.equal(attrs.sandbox, "allow-scripts");
    assert.equal(attrs.referrerpolicy, "no-referrer");
    assert.equal("allow" in attrs, false, "no permissions-policy grants");
    assert.ok(!Object.values(attrs).some((value) => value.includes("allow-same-origin")));
  }
});

test("no UI source grants allow-same-origin anywhere", () => {
  const offenders = [];
  for (const root of SOURCE_ROOTS) {
    if (!fs.existsSync(root)) continue;
    for (const file of sourceFiles(root)) {
      const lines = fs.readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        const code = line.replace(/\/\/.*$/, "").replace(/^\s*(\/\*\*?|\*).*$/, "");
        if (code.includes("allow-same-origin")) offenders.push(`${path.relative(repoCrates, file)}:${index + 1}`);
      });
    }
  }
  assert.deepEqual(offenders, []);
});

test("sandboxed UI components only create iframes through SandboxedFrame", () => {
  const dirs = ["agent-ui/src/components/sandboxed-ui", "agent-ui/src/components/chat/assistant-bubble", "agent-ui/src/components/project-tools", "agent-ui/src/pages/settings"];
  const offenders = [];
  for (const dir of dirs) {
    for (const file of sourceFiles(path.join(repoCrates, dir))) {
      if (file.endsWith("SandboxedFrame.tsx")) continue;
      if (/<iframe\b/.test(fs.readFileSync(file, "utf8"))) offenders.push(path.relative(repoCrates, file));
    }
  }
  assert.deepEqual(offenders, []);
});
