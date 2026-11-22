import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const quickOpen = loader.loadModule("@liveagent/ui/lib/chat/fileQuickOpen.ts");
const protocol = loader.loadModule("@liveagent/ui/lib/chat/fileQuickOpenProtocol.ts");
const palette = loader.loadModule("@liveagent/ui/lib/chat/commandPalette.ts");

const PATHS = [
  "README.md",
  "src/index.ts",
  "src/components/Button.tsx",
  "src/components/ButtonGroup.tsx",
  "src/lib/buttonUtils.ts",
  "docs/guides/button-recipes.md",
  "src/pages/settings/SettingsShell.tsx",
  "test/settings-shell.test.mjs",
];

const top = (query, limit) => quickOpen.searchQuickOpenPaths(PATHS, query, limit).map((m) => m.path);

test("prefixes pick one palette scope; plain text searches everything", () => {
  assert.deepEqual(palette.parseCommandPaletteQuery("  > theme "), {
    scope: "actions",
    actionsOnly: true,
    query: "theme",
  });
  assert.deepEqual(palette.parseCommandPaletteQuery("@ button"), {
    scope: "files",
    actionsOnly: false,
    query: "button",
  });
  assert.deepEqual(palette.parseCommandPaletteQuery("#notes"), {
    scope: "conversations",
    actionsOnly: false,
    query: "notes",
  });
  assert.deepEqual(palette.parseCommandPaletteQuery(" plain "), {
    scope: "all",
    actionsOnly: false,
    query: "plain",
  });
  assert.deepEqual(
    palette.COMMAND_PALETTE_SCOPE_PREFIXES.map((entry) => entry.prefix),
    [">", "@", "#"],
  );
});

test("fuzzy file match prefers file names, runs and word starts", () => {
  assert.equal(top("button")[0], "src/components/Button.tsx", "exact stem wins");
  assert.equal(top("btngrp")[0], "src/components/ButtonGroup.tsx", "camelCase humps match");
  assert.deepEqual(top("shell").slice(0, 2).sort(), [
    "src/pages/settings/SettingsShell.tsx",
    "test/settings-shell.test.mjs",
  ], "dash and camelCase word starts rank alike");
  assert.equal(top("shell tsx")[0], "src/pages/settings/SettingsShell.tsx", "spaces are ignored");
  assert.deepEqual(top("zzz"), [], "no subsequence, no match");
  assert.equal(quickOpen.scoreQuickOpenPath("src/index.ts", "xi"), null);

  const match = quickOpen.scoreQuickOpenPath("src/components/Button.tsx", "btn");
  assert.deepEqual(match.positions, [15, 17, 20], "positions point at matched characters");
  assert.deepEqual(
    quickOpen.splitQuickOpenHighlights("Button.tsx", match.positions, 15).filter((run) => run.highlighted).map((run) => run.text),
    ["B", "t", "n"],
  );

  assert.deepEqual(top("", 3), PATHS.slice(0, 3), "empty query keeps backend order");
  assert.equal(top("s", 2).length, 2, "results are capped");
});

test("fuzzy search over a large index stays fast", () => {
  const paths = [];
  for (let i = 0; i < 20_000; i += 1) paths.push(`pkg${i % 97}/src/module${i}/file${i}.ts`);
  const started = performance.now();
  const matches = quickOpen.searchQuickOpenPaths(paths, "mod123file", 50);
  const elapsed = performance.now() - started;
  assert.equal(matches[0].path, "pkg26/src/module123/file123.ts");
  assert.ok(elapsed < 1500, `20k paths took ${elapsed.toFixed(0)}ms`);
});

test("search client drops superseded results and falls back without a worker", async () => {
  const { createQuickOpenSearchClient } = loader.loadModule(
    "@liveagent/ui/lib/chat/fileQuickOpenSearch.ts",
  );

  // Synchronous fallback (no Worker in this environment).
  const local = createQuickOpenSearchClient({ createWorker: () => null });
  assert.equal(local.usesWorker, false);
  local.setIndex("/w", PATHS);
  const first = local.search("/w", "button");
  const second = local.search("/w", "shelltsx");
  assert.equal(await first, null, "older search is superseded");
  assert.equal((await second)[0].path, "src/pages/settings/SettingsShell.tsx");

  // Worker transport: responses may arrive out of order.
  const posted = [];
  const fakeWorker = {
    postMessage: (message) => posted.push(message),
    terminate() {},
  };
  const client = createQuickOpenSearchClient({ createWorker: () => fakeWorker });
  assert.equal(client.usesWorker, true);
  client.setIndex("/w", PATHS);
  const indexes = new Map();
  protocol.runQuickOpenWorkerRequest(indexes, posted[0]);
  assert.equal(posted[0].type, "index", "the index is posted once");
  const a = client.search("/w", "button");
  const b = client.search("/w", "readme");
  const reply = (request) =>
    fakeWorker.onmessage({ data: protocol.runQuickOpenWorkerRequest(indexes, request) });
  reply(posted[2]);
  reply(posted[1]);
  assert.equal(await a, null);
  assert.deepEqual((await b).map((m) => m.path), ["README.md"]);
  assert.ok(posted.slice(1).every((message) => !("paths" in message)), "searches only post the query");

  // A crashing worker hands the pending search to the local mirror.
  const c = client.search("/w", "index");
  fakeWorker.onerror(new Event("error"));
  assert.equal(client.usesWorker, false);
  assert.equal((await c)[0].path, "src/index.ts");
  client.dispose();
});

test("file index lists files only, skips hidden ones, caches briefly and retries failures", async () => {
  const { loadQuickOpenFileIndex, clearQuickOpenFileIndexCache, QUICK_OPEN_INDEX_TTL_MS } =
    loader.loadModule("@liveagent/ui/lib/chat/fileQuickOpenSearch.ts");
  clearQuickOpenFileIndexCache();
  let calls = 0;
  const listFiles = async (workdir) => {
    calls += 1;
    assert.equal(workdir, "/repo");
    return {
      truncated: true,
      entries: [
        { path: "src", kind: "dir" },
        { path: "src/a.ts", kind: "file" },
        { path: ".env", kind: "file", hidden: true },
      ],
    };
  };
  const index = await loadQuickOpenFileIndex("/repo", { listFiles, now: 1000 });
  assert.deepEqual(index, { workdir: "/repo", paths: ["src/a.ts"], truncated: true });
  await loadQuickOpenFileIndex("/repo", { listFiles, now: 1000 + QUICK_OPEN_INDEX_TTL_MS - 1 });
  assert.equal(calls, 1, "fresh listings are reused");
  await loadQuickOpenFileIndex("/repo", { listFiles, now: 1000 + QUICK_OPEN_INDEX_TTL_MS });
  assert.equal(calls, 2, "stale listings are refreshed");

  clearQuickOpenFileIndexCache();
  const failing = async () => {
    throw new Error("denied");
  };
  await assert.rejects(loadQuickOpenFileIndex("/repo", { listFiles: failing, now: 5 }));
  await loadQuickOpenFileIndex("/repo", { listFiles, now: 6 });
  assert.equal(calls, 3, "a failed listing is not cached");
});

async function createDialogEnv(listCalls) {
  const iconProxy = () =>
    new Proxy({}, { get: (_target, name) => (name === "__esModule" ? false : () => null) });
  return createDomTestEnv({
    mocks: {
      "@liveagent/ui/components/IconSet": iconProxy(),
      "../IconSet": iconProxy(),
      "@liveagent/ui/i18n/index": { useLocale: () => ({ t: (key) => key, locale: "en" }) },
      "@liveagent/ui/lib/chat/conversationSearch": {
        searchPersistedConversations: async ({ query }) => [{ id: `hit-${query}`, title: `Hit ${query}` }],
      },
      "../tools/fsBackend": {
        invokeFs: async (command, args) => {
          listCalls.push({ command, args });
          return {
            truncated: false,
            entries: PATHS.map((path) => ({ path, kind: "file" })),
          };
        },
      },
    },
  });
}

test("palette scopes: @ quick-opens files, # searches conversations, hints switch scope", async () => {
  const listCalls = [];
  const env = await createDialogEnv(listCalls);
  const { React, act, createRoot } = env;
  HTMLElement.prototype.scrollIntoView = () => {};
  const { clearQuickOpenFileIndexCache } = env.loadModule(
    "@liveagent/ui/lib/chat/fileQuickOpenSearch.ts",
  );
  clearQuickOpenFileIndexCache();
  const { ConversationSearchDialog } = env.loadModule(
    "@liveagent/ui/components/chat/ConversationSearchDialog.tsx",
  );
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const events = [];
  const props = {
    open: true,
    mode: "palette",
    getActions: () => [
      { id: "toggle-theme", group: "view", label: "Switch theme", run: () => events.push("theme") },
    ],
    getFileSource: () => ({ workdir: "/repo", open: (path) => events.push(["open-file", path]) }),
    conversations: [{ id: "recent", title: "Recent chat" }],
    onOpenChange: (value) => events.push(["open", value]),
    onSelectConversation: (id) => events.push(["select", id]),
  };
  const render = (changes) =>
    act(async () => root.render(React.createElement(ConversationSearchDialog, { ...props, ...changes })));
  const input = () => document.querySelector("input");
  const options = () => [...document.querySelectorAll('[role="option"]')];
  const fileOptions = () =>
    options().map((el) => el.getAttribute("data-command-palette-file")).filter(Boolean);
  const type = (value) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input(), value);
      input().dispatchEvent(new Event("input", { bubbles: true }));
    });
  const key = (value) =>
    act(async () =>
      input().dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true })),
    );
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 220)));

  try {
    await render();
    const hints = [...document.querySelectorAll("[data-command-palette-scope]")];
    assert.deepEqual(
      hints.map((el) => el.getAttribute("data-command-palette-scope")),
      ["actions", "files", "conversations"],
      "the empty palette explains the prefixes",
    );
    assert.equal(listCalls.length, 0, "files are only listed once the @ scope is used");

    await act(async () => hints[1].click());
    await settle();
    assert.equal(input().value, "@", "a hint fills in its prefix");
    assert.equal(document.querySelector("[data-command-palette-scope-hints]"), null);
    assert.deepEqual(listCalls, [
      { command: "fs_mention_list", args: { workdir: "/repo", max_results: 20000, query: "" } },
    ]);
    assert.deepEqual(fileOptions(), PATHS.slice(0, PATHS.length), "empty @ lists the index");
    assert.ok(!options().some((el) => el.textContent === "Recent chat"), "@ hides conversations");

    await type("@btngrp");
    await settle();
    assert.equal(fileOptions()[0], "src/components/ButtonGroup.tsx");
    assert.ok(options()[0].querySelector("mark"), "matched characters are highlighted");
    await key("ArrowDown");
    await key("ArrowUp");
    await key("Enter");
    assert.deepEqual(events, [["open", false], ["open-file", "src/components/ButtonGroup.tsx"]]);
    events.length = 0;

    await type("#Recent");
    await settle();
    assert.deepEqual(fileOptions(), []);
    assert.ok(
      !options().some((el) => el.hasAttribute("data-command-palette-action")),
      "# never lists actions",
    );
    assert.ok(options().some((el) => el.textContent === "Hit Recent"), "# searches conversations");

    await type("#");
    await settle();
    assert.deepEqual(options().map((el) => el.textContent), ["Recent chat"], "empty # lists recents");

    // Opening straight into the file scope (the quick-open shortcut).
    await render({ open: false });
    await render({ open: true, initialQuery: "@", openRequestKey: 1 });
    await settle();
    assert.equal(input().value, "@");
    assert.ok(fileOptions().length > 0);
    assert.equal(listCalls.length, 1, "a fresh index is reused across palette sessions");

    await render({ open: false });
    await render({ open: true, initialQuery: "@", openRequestKey: 2, getFileSource: () => null });
    await settle();
    assert.match(
      document.querySelector('[role="status"]').textContent,
      /chat\.commandPalette\.filesUnavailable/,
      "without a project the @ scope says why it is empty",
    );
  } finally {
    await act(async () => root.unmount());
    host.remove();
    env.cleanup();
  }
});

test("hosts wire the file scope and the quick-open shortcut", () => {
  const read = (relative) => fs.readFileSync(new URL(relative, import.meta.url), "utf8");
  const sidebar = read("../../../agent-ui/src/components/chat/ChatHistorySidebar.tsx");
  assert.match(sidebar, /matchesShortcutCommand\(event, "quickOpenFile", isMac\)/);
  assert.match(sidebar, /getFileSource=\{getCommandPaletteFiles\}/);
  for (const host of [
    "../../src/pages/ChatPage.tsx",
    "../../../agent-gateway/web/src/app/GatewayAppView.tsx",
  ]) {
    const source = read(host);
    assert.match(source, /getCommandPaletteFiles=\{getCommandPaletteFiles\}/, host);
    assert.match(source, /handleOpenWorkspaceFile\(path\)/, host);
  }
  const worker = read("../../../agent-ui/src/lib/chat/fileQuickOpenSearch.ts");
  assert.match(worker, /new Worker\(new URL\("\.\/fileQuickOpen\.worker\.ts", import\.meta\.url\)/);
});
