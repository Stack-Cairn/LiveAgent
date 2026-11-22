// The file tree data layer at scale: a 50k-node workspace with every directory expanded, an
// initial load and a watcher reset (every visible listing reloaded at once). Checks that the
// resulting tree is exactly the filesystem, that unchanged listings keep the node map, and
// that a burst of listings is applied in one commit.
//
// FILE_TREE_BENCH=1 node --test test/workspace/file-tree-data-refresh.test.mjs  prints timings.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const locale = { t: (key) => key };
const fs = { listings: new Map(), calls: 0, delay: null };
const activity = { listener: null };
const env = await createDomTestEnv({
  mocks: {
    "@liveagent/ui/i18n/index": { useLocale: () => locale },
    "../../../lib/editors/editors": { openPathInEditor: async () => {} },
    "../../../lib/tools/fsBackend": {
      isFsBackendError: () => false,
      invokeFs: async (command, args) => {
        assert.equal(command, "fs_list");
        fs.calls++;
        if (fs.delay) await fs.delay;
        const entries = fs.listings.get(args.path ?? "") ?? [];
        return { entries: entries.map((entry) => ({ ...entry })), hasMore: false };
      },
    },
  },
});
after(() => env.cleanup());
const { useFileTreeData } = env.loadModule("@liveagent/ui/components/project-tools/file-tree/useFileTreeData.ts");
const model = env.loadModule("@liveagent/ui/components/project-tools/file-tree/model.ts");
const { React, act, createRoot } = env;

// 50 top-level dirs x 10 subdirs x 99 files = 50,050 nodes (+ root).
function buildWorkspace({ top = 50, sub = 10, files = 99 } = {}) {
  const listings = new Map();
  const dirs = [""];
  const rootEntries = [];
  for (let a = 0; a < top; a++) {
    const dir = `pkg${String(a).padStart(2, "0")}`;
    rootEntries.push({ path: dir, kind: "dir", hidden: false });
    dirs.push(dir);
    const subEntries = [];
    for (let b = 0; b < sub; b++) {
      const subdir = `${dir}/mod${String(b).padStart(2, "0")}`;
      subEntries.push({ path: subdir, kind: "dir", hidden: false });
      dirs.push(subdir);
      const fileEntries = [];
      for (let c = 0; c < files; c++) {
        fileEntries.push({ path: `${subdir}/file${String(c).padStart(3, "0")}.ts`, kind: "file", hidden: false });
      }
      listings.set(subdir, fileEntries);
    }
    listings.set(dir, subEntries);
  }
  listings.set("", rootEntries);
  return { listings, dirs, nodeCount: [...listings.values()].reduce((sum, list) => sum + list.length, 1) };
}

function mount({ expandedPaths, externalRoots = [] }) {
  const state = { result: null, renders: 0 };
  const client = { subscribe: (_cwd, listener) => { activity.listener = listener; return () => {}; } };
  function Probe(props) {
    state.renders++;
    state.result = useFileTreeData(props);
    return null;
  }
  const props = {
    projectPathKey: "/workspace", cwd: "/workspace", externalRoots, active: true, initialized: true,
    workspaceActivityClient: client, expandedPaths, query: "", showHidden: false,
  };
  const container = document.createElement("div");
  const root = createRoot(container);
  return {
    state,
    async render(next = {}) {
      Object.assign(props, next);
      await act(async () => root.render(React.createElement(Probe, { ...props })));
    },
    unmount: () => act(() => root.unmount()),
  };
}

async function settle(predicate) {
  for (let round = 0; round < 1000; round++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1)); });
    if (predicate()) return;
  }
  throw new Error("file tree did not settle");
}

function assertMatchesFilesystem(nodes, listings) {
  for (const [path, entries] of listings) {
    const node = nodes[path];
    assert.ok(node?.loaded, `${path || "<root>"} is loaded`);
    assert.deepEqual(
      node.children.filter((child) => !model.isExternalRootPath(child)),
      model.sortFileTreeEntries(entries).map((entry) => entry.path),
      `${path || "<root>"} children`,
    );
  }
  const expected = new Set([""]);
  for (const entries of listings.values()) for (const entry of entries) expected.add(entry.path);
  for (const path of Object.keys(nodes)) {
    if (model.isExternalRootPath(path)) continue;
    assert.ok(expected.has(path), `no stale node ${path}`);
  }
}

const allLoaded = (state, dirs) => () => dirs.every((dir) => state.result?.nodes[dir]?.loaded);

test("a watcher reset reloads every visible listing and lands deletions, additions and renames", async () => {
  const workspace = buildWorkspace({ top: 6, sub: 4, files: 5 });
  fs.listings = workspace.listings;
  const view = mount({ expandedPaths: workspace.dirs });
  await view.render();
  await settle(allLoaded(view.state, workspace.dirs));
  assertMatchesFilesystem(view.state.result.nodes, workspace.listings);
  const loadedNodes = view.state.result.nodes;

  // Nothing changed on disk: the reset reloads everything but keeps the same node map.
  fs.calls = 0;
  await act(async () => activity.listener({ kind: "reset" }));
  await settle(() => fs.calls === workspace.dirs.length);
  await settle(() => true);
  assert.equal(view.state.result.nodes, loadedNodes, "unchanged listings keep the node map");

  // Delete a whole subtree, add a file, rename a directory.
  fs.listings.set("", fs.listings.get("").filter((entry) => entry.path !== "pkg05"));
  fs.listings.get("pkg00/mod00").push({ path: "pkg00/mod00/new.ts", kind: "file", hidden: false });
  fs.listings.set("pkg01", fs.listings.get("pkg01").map((entry) =>
    entry.path === "pkg01/mod03" ? { ...entry, path: "pkg01/renamed" } : entry));
  fs.listings.set("pkg01/renamed", [{ path: "pkg01/renamed/a.ts", kind: "file", hidden: false }]);
  for (const key of [...fs.listings.keys()]) {
    if (key.startsWith("pkg05") || key === "pkg01/mod03") fs.listings.delete(key);
  }
  const expanded = workspace.dirs.filter((dir) => !dir.startsWith("pkg05") && dir !== "pkg01/mod03").concat("pkg01/renamed");
  await view.render({ expandedPaths: expanded });
  await act(async () => activity.listener({ kind: "reset" }));
  await settle(allLoaded(view.state, expanded));
  await settle(() => true);
  assertMatchesFilesystem(view.state.result.nodes, fs.listings);
  await view.unmount();
});

test("attached roots stay attached through listings and leave with their grant", async () => {
  const workspace = buildWorkspace({ top: 2, sub: 1, files: 2 });
  fs.listings = workspace.listings;
  const extra = { id: "docs", name: "Docs", cwd: "/elsewhere/docs" };
  const view = mount({ expandedPaths: workspace.dirs, externalRoots: [extra] });
  await view.render();
  await settle(allLoaded(view.state, workspace.dirs));
  const externalPath = model.externalRootPath("docs");
  assert.ok(view.state.result.nodes[""].children.includes(externalPath));
  assert.equal(view.state.result.nodes[externalPath].name, "Docs");
  await act(async () => activity.listener({ kind: "reset" }));
  await settle(() => true);
  assert.ok(view.state.result.nodes[""].children.includes(externalPath), "a root refresh keeps it");

  await view.render({ externalRoots: [] });
  assert.equal(view.state.result.nodes[externalPath], undefined);
  assert.ok(!view.state.result.nodes[""].children.includes(externalPath));
  assertMatchesFilesystem(view.state.result.nodes, workspace.listings);
  await view.unmount();
});

test("listings released together all land", async () => {
  const workspace = buildWorkspace({ top: 8, sub: 2, files: 3 });
  fs.listings = workspace.listings;
  const view = mount({ expandedPaths: workspace.dirs });
  await view.render();
  await settle(allLoaded(view.state, workspace.dirs));
  // Change every listing, then release all reload responses at once.
  for (const [path, entries] of fs.listings) {
    if (path.includes("/mod")) entries.push({ path: `${path}/added.ts`, kind: "file", hidden: false });
  }
  let release;
  fs.delay = new Promise((resolve) => { release = resolve; });
  await act(async () => activity.listener({ kind: "reset" }));
  fs.delay = null;
  await act(async () => { release(); });
  await settle(() => view.state.result.nodes["pkg07/mod01"].children.length === 4);
  await settle(() => true);
  assertMatchesFilesystem(view.state.result.nodes, fs.listings);
  await view.unmount();
});

test("a batch of listings equals applying them one by one and copies the map once", () => {
  const workspace = buildWorkspace({ top: 4, sub: 3, files: 4 });
  const depth = (path) => (path ? path.split("/").length : 0);
  const listings = (map) => [...map].sort(([a], [b]) => depth(a) - depth(b)).map(([path, entries]) => ({ path, cwd: "/workspace", entries: model.sortFileTreeEntries(entries), listError: undefined }));
  const loaded = model.applyFileTreeListResponses({}, listings(workspace.listings));
  assertMatchesFilesystem(loaded, workspace.listings);
  assert.equal(model.applyFileTreeListResponses(loaded, listings(workspace.listings)), loaded, "unchanged: same map");

  const changed = new Map([...workspace.listings].map(([path, entries]) => [path, [...entries]]));
  changed.set("", changed.get("").filter((entry) => entry.path !== "pkg03"));
  changed.get("pkg00/mod00").push({ path: "pkg00/mod00/new.ts", kind: "file", hidden: false });
  changed.set("pkg01/mod02", []);
  const batch = listings(changed).filter(({ path }) => !path.startsWith("pkg03"));
  let sequential = loaded;
  for (const listing of batch) {
    sequential = model.applyFileTreeListResponse(sequential, listing.path, listing.cwd, listing.entries, listing.listError);
  }
  const batched = model.applyFileTreeListResponses(loaded, batch);
  assert.deepEqual(batched, sequential);
  assert.equal(batched["pkg03"], undefined);
  assert.equal(batched["pkg03/mod00/file000.ts"], undefined, "a removed subtree is pruned");
  assert.equal(batched["pkg02/mod00"], loaded["pkg02/mod00"], "untouched nodes keep their identity");
  assert.equal(loaded["pkg03"].kind, "dir", "the input map is not mutated");
});

test("re-attaching roots without the revoked-root scan keeps nodes but fixes the primary root", () => {
  const roots = [{ id: "docs", name: "Docs", cwd: "/elsewhere/docs" }];
  const base = model.applyFileTreeExternalRoots(
    model.applyFileTreeListResponse({}, "", "/workspace", [{ path: "a", kind: "dir", hidden: false }], undefined),
    roots,
  );
  const externalPath = model.externalRootPath("docs");
  // A primary-root listing drops the attached roots from the root's children.
  const listed = model.applyFileTreeListResponse(base, "", "/workspace", [{ path: "b", kind: "file", hidden: false }], undefined);
  assert.ok(!listed[""].children.includes(externalPath));
  const reattached = model.applyFileTreeExternalRoots(listed, roots, { pruneRevoked: false });
  assert.deepEqual(reattached[""].children, ["b", externalPath]);
  assert.equal(model.applyFileTreeExternalRoots(reattached, roots, { pruneRevoked: false }), reattached);
  // With the roots revoked, only the full reconcile removes their nodes.
  assert.ok(model.applyFileTreeExternalRoots(reattached, [], { pruneRevoked: false })[externalPath]);
  assert.equal(model.applyFileTreeExternalRoots(reattached, [])[externalPath], undefined);
});

test("50k-node workspace: initial load and watcher reset", { skip: !process.env.FILE_TREE_BENCH }, async () => {
  const workspace = buildWorkspace();
  fs.listings = workspace.listings;
  for (let round = 0; round < 3; round++) {
    const view = mount({ expandedPaths: workspace.dirs });
    let started = performance.now();
    await view.render();
    await settle(allLoaded(view.state, workspace.dirs));
    const initial = performance.now() - started;
    const loaded = view.state.result.nodes;

    fs.calls = 0;
    started = performance.now();
    await act(async () => activity.listener({ kind: "reset" }));
    await settle(() => fs.calls >= workspace.dirs.length);
    await settle(() => true);
    const resetUnchanged = performance.now() - started;
    assert.equal(Object.keys(view.state.result.nodes).length, workspace.nodeCount);

    // A reset where one file changed in every listing.
    for (const [path, entries] of fs.listings) {
      if (path.includes("/mod")) entries.push({ path: `${path}/zz-added-${round}.ts`, kind: "file", hidden: false });
    }
    started = performance.now();
    await act(async () => activity.listener({ kind: "reset" }));
    await settle(() => view.state.result.nodes !== loaded && view.state.result.nodes["pkg49/mod09"].children.length === 100);
    await settle(() => true);
    const resetChanged = performance.now() - started;
    console.log(`round ${round}: ${Object.keys(view.state.result.nodes).length} nodes; initial load ${initial.toFixed(0)} ms; reset (unchanged) ${resetUnchanged.toFixed(0)} ms; reset (every listing changed) ${resetChanged.toFixed(0)} ms; renders ${view.state.renders}`);
    await view.unmount();
    for (const [path, entries] of fs.listings) {
      if (path.includes("/mod")) entries.splice(entries.findIndex((entry) => entry.path.includes("zz-added")), 1);
    }
  }
});
