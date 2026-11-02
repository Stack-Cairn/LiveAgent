// End-to-end regression for the composer branch selector spinner: renders the
// real shared GitBranchSelector against a fake gitClient whose branches()
// calls stay pending until the test settles them, plus a fake
// workspaceActivityClient that delivers the git invalidation the desktop
// watcher emits when .git/HEAD changes.
import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

let ReactRef = null;
const iconCache = new Map();
function iconComponent(name) {
  if (!iconCache.has(name)) {
    iconCache.set(name, (props) =>
      ReactRef.createElement("svg", { "data-icon": name, className: props?.className }),
    );
  }
  return iconCache.get(name);
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function repoState(head) {
  return {
    repoRoot: "/repo",
    workdir: "/repo",
    head,
    upstream: "",
    remoteName: "",
    remoteUrl: "",
    ahead: 0,
    behind: 0,
    stashCount: 0,
    dirtyCounts: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
    entries: [],
    status: "ready",
    error: null,
  };
}

function branchesResponse(head) {
  const branch = (name) => ({
    name,
    fullName: name,
    kind: "local",
    current: name === head,
    upstream: "",
    ahead: 0,
    behind: 0,
  });
  return { state: repoState(head), branches: [branch("main"), branch("feature")], worktrees: [] };
}

async function setup() {
  const env = await createDomTestEnv({
    mocks: {
      "@liveagent/ui/components/IconSet": new Proxy(
        {},
        { get: (_target, name) => (name === "__esModule" ? true : iconComponent(String(name))) },
      ),
      "@liveagent/ui/i18n/index": { useLocale: () => ({ t: (key) => key }) },
    },
  });
  ReactRef = env.React;
  window.HTMLElement.prototype.getAnimations ??= () => [];
  const { GitBranchSelector } = env.loadModule(
    "@liveagent/ui/components/git/GitBranchSelector.tsx",
  );

  const pending = [];
  const calls = { switchBranch: [] };
  const gitClient = {
    branches: () => {
      const next = deferred();
      pending.push(next);
      return next.promise;
    },
    switchBranch: async (...args) => {
      calls.switchBranch.push(args);
      return { ok: true };
    },
  };
  const listeners = new Set();
  let revision = 0;
  const workspaceActivityClient = {
    subscribe(_workdir, listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const emitGitActivity = async () => {
    revision += 1;
    await env.act(async () => {
      for (const listener of listeners) {
        listener({
          workdir: "/repo",
          revision,
          fs: false,
          git: true,
          changedPaths: [".git/HEAD"],
          truncated: false,
        });
      }
    });
  };

  const container = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(container);
  await env.act(async () =>
    root.render(
      env.React.createElement(GitBranchSelector, {
        workdir: "/repo",
        gitClient,
        workspaceActivityClient,
      }),
    ),
  );

  const trigger = () => container.querySelector("button");
  const triggerIcon = () => trigger().querySelector("svg")?.getAttribute("data-icon");
  const triggerLabel = () => trigger().textContent.trim();
  const settle = async (index, value) => {
    await env.act(async () => {
      pending[index].resolve(value);
      await pending[index].promise;
    });
  };
  const switchToFeature = async () => {
    await env.act(async () => trigger().click());
    const row = [...document.querySelectorAll('[role="menuitem"]')].find((node) =>
      node.textContent.includes("feature"),
    );
    assert.ok(row, "feature branch row is rendered in the open menu");
    await env.act(async () => row.click());
    const confirmButton = [...document.querySelectorAll("button")].find(
      (node) => node.textContent.trim() === "git.branchSelector.switchConfirmAction",
    );
    assert.ok(confirmButton, "switch confirmation dialog is shown");
    await env.act(async () => confirmButton.click());
  };
  const cleanup = async () => {
    await env.act(async () => root.unmount());
    ReactRef = null;
    env.cleanup();
  };
  return {
    pending,
    calls,
    emitGitActivity,
    triggerIcon,
    triggerLabel,
    settle,
    switchToFeature,
    cleanup,
  };
}

test("git-branch: mount refresh overtaken by a forced silent git refresh does not spin forever", async () => {
  const h = await setup();
  try {
    assert.equal(h.pending.length, 1, "mount issues one interactive refresh");
    assert.equal(h.triggerIcon(), "Loader2");
    await h.emitGitActivity();
    assert.equal(h.pending.length, 2, "git invalidation issues a forced silent refresh");
    await h.settle(0, branchesResponse("main"));
    await h.settle(1, branchesResponse("main"));
    assert.equal(h.triggerIcon(), "GitBranch", "spinner must stop once both settle");
    assert.equal(h.triggerLabel(), "main");
  } finally {
    await h.cleanup();
  }
});

test("git-branch: switching branches through the menu stops spinning when the watcher refresh overtakes", async () => {
  const h = await setup();
  try {
    await h.settle(0, branchesResponse("main"));
    assert.equal(h.triggerIcon(), "GitBranch");
    await h.switchToFeature();
    assert.deepEqual(h.calls.switchBranch, [["/repo", "feature", "local"]]);
    assert.equal(h.pending.length, 2, "post-switch interactive refresh is pending");
    assert.equal(h.triggerIcon(), "Loader2");

    // The .git/HEAD rewrite reaches the watcher before the interactive refresh lands.
    await h.emitGitActivity();
    assert.equal(h.pending.length, 3);

    await h.settle(1, branchesResponse("feature"));
    await h.settle(2, branchesResponse("feature"));
    assert.equal(h.triggerIcon(), "GitBranch", "spinner must stop after the switch settles");
    assert.equal(h.triggerLabel(), "feature");
  } finally {
    await h.cleanup();
  }
});

test("git-branch: silent refresh landing first keeps the new branch and drops the stale interactive response", async () => {
  const h = await setup();
  try {
    await h.settle(0, branchesResponse("main"));
    await h.switchToFeature();
    await h.emitGitActivity();
    assert.equal(h.pending.length, 3);

    // The newest (silent) request lands first. The mutation is still awaiting
    // its own refresh, so the trigger keeps spinning through `mutating`.
    await h.settle(2, branchesResponse("feature"));
    assert.equal(h.triggerLabel(), "feature");
    assert.equal(h.triggerIcon(), "Loader2", "mutation still in progress");
    // The overtaken interactive request then returns stale data.
    await h.settle(1, branchesResponse("main"));
    assert.equal(
      h.triggerLabel(),
      "feature",
      "stale interactive response must not flash the old branch",
    );
    assert.equal(h.triggerIcon(), "GitBranch");
  } finally {
    await h.cleanup();
  }
});
