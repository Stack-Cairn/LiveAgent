import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const guiRoot = fileURLToPath(new URL("../..", import.meta.url));
const graphModules = {
  gui: createTsModuleLoader().loadModule("src/lib/git/gitGraph.ts"),
  web: createTsModuleLoader({
    rootDir: path.resolve(guiRoot, "..", "agent-gateway", "web"),
  }).loadModule("src/lib/git/gitGraph.ts"),
};

function simplifyRows(rows) {
  return rows.map((row) => ({
    sha: row.sha,
    parents: row.parents,
    commitCol: row.commitCol,
    commitColor: row.commitColor,
    inputLanes: row.inputLanes,
    outputLanes: row.outputLanes,
    isHead: row.isHead,
    isMerge: row.isMerge,
  }));
}

for (const [surface, graph] of Object.entries(graphModules)) {
  test(`${surface} git graph uses VS Code source control graph colors`, () => {
    assert.deepEqual(graph.GRAPH_COLORS, [
      "#ffb000",
      "#dc267f",
      "#994f00",
      "#40b0a6",
      "#b66dff",
    ]);
  });

  test(`${surface} git graph exposes VS Code ref semantic colors`, () => {
    assert.deepEqual(graph.GRAPH_REF_COLORS, {
      local: "var(--git-review-graph-ref-local)",
      remote: "var(--git-review-graph-ref-remote)",
      base: "var(--git-review-graph-ref-base)",
    });
  });

  test(`${surface} git graph builds linear swimlanes`, () => {
    const result = graph.computeGitGraph([
      { sha: "c", parents: ["b"] },
      { sha: "b", parents: ["a"] },
      { sha: "a", parents: [] },
    ]);

    assert.equal(result.maxCols, 1);
    assert.deepEqual(simplifyRows(result.rows), [
      {
        sha: "c",
        parents: ["b"],
        commitCol: 0,
        commitColor: 0,
        inputLanes: [],
        outputLanes: [{ id: "b", color: 0 }],
        isHead: true,
        isMerge: false,
      },
      {
        sha: "b",
        parents: ["a"],
        commitCol: 0,
        commitColor: 0,
        inputLanes: [{ id: "b", color: 0 }],
        outputLanes: [{ id: "a", color: 0 }],
        isHead: false,
        isMerge: false,
      },
      {
        sha: "a",
        parents: [],
        commitCol: 0,
        commitColor: 0,
        inputLanes: [{ id: "a", color: 0 }],
        outputLanes: [],
        isHead: false,
        isMerge: false,
      },
    ]);
  });

  test(`${surface} git graph preserves merge branch lanes and base joins`, () => {
    const result = graph.computeGitGraph([
      { sha: "m", parents: ["a", "b"] },
      { sha: "a", parents: ["r"] },
      { sha: "b", parents: ["r"] },
      { sha: "r", parents: [] },
    ]);

    assert.equal(result.maxCols, 2);
    assert.deepEqual(simplifyRows(result.rows), [
      {
        sha: "m",
        parents: ["a", "b"],
        commitCol: 0,
        commitColor: 0,
        inputLanes: [],
        outputLanes: [
          { id: "a", color: 0 },
          { id: "b", color: 1 },
        ],
        isHead: true,
        isMerge: true,
      },
      {
        sha: "a",
        parents: ["r"],
        commitCol: 0,
        commitColor: 0,
        inputLanes: [
          { id: "a", color: 0 },
          { id: "b", color: 1 },
        ],
        outputLanes: [
          { id: "r", color: 0 },
          { id: "b", color: 1 },
        ],
        isHead: false,
        isMerge: false,
      },
      {
        sha: "b",
        parents: ["r"],
        commitCol: 1,
        commitColor: 1,
        inputLanes: [
          { id: "r", color: 0 },
          { id: "b", color: 1 },
        ],
        outputLanes: [
          { id: "r", color: 0 },
          { id: "r", color: 1 },
        ],
        isHead: false,
        isMerge: false,
      },
      {
        sha: "r",
        parents: [],
        commitCol: 0,
        commitColor: 0,
        inputLanes: [
          { id: "r", color: 0 },
          { id: "r", color: 1 },
        ],
        outputLanes: [],
        isHead: false,
        isMerge: false,
      },
    ]);
  });

  test(`${surface} git graph colors local and remote refs like VS Code`, () => {
    const result = graph.computeGitGraph(
      [
        { sha: "tip", parents: ["merge", "side"] },
        { sha: "merge", parents: ["base"], refs: ["main"] },
        { sha: "side", parents: ["base"], refs: ["origin/side"] },
        { sha: "base", parents: [] },
      ],
      {
        currentRef: "main",
        remoteRef: "origin/side",
        remoteName: "origin",
      },
    );

    assert.deepEqual(simplifyRows(result.rows), [
      {
        sha: "tip",
        parents: ["merge", "side"],
        commitCol: 0,
        commitColor: 0,
        inputLanes: [],
        outputLanes: [
          { id: "merge", color: 0 },
          { id: "side", color: graph.GRAPH_REF_COLORS.remote },
        ],
        isHead: false,
        isMerge: true,
      },
      {
        sha: "merge",
        parents: ["base"],
        commitCol: 0,
        commitColor: 0,
        inputLanes: [
          { id: "merge", color: 0 },
          { id: "side", color: graph.GRAPH_REF_COLORS.remote },
        ],
        outputLanes: [
          { id: "base", color: graph.GRAPH_REF_COLORS.local },
          { id: "side", color: graph.GRAPH_REF_COLORS.remote },
        ],
        isHead: true,
        isMerge: false,
      },
      {
        sha: "side",
        parents: ["base"],
        commitCol: 1,
        commitColor: graph.GRAPH_REF_COLORS.remote,
        inputLanes: [
          { id: "base", color: graph.GRAPH_REF_COLORS.local },
          { id: "side", color: graph.GRAPH_REF_COLORS.remote },
        ],
        outputLanes: [
          { id: "base", color: graph.GRAPH_REF_COLORS.local },
          { id: "base", color: graph.GRAPH_REF_COLORS.remote },
        ],
        isHead: false,
        isMerge: false,
      },
      {
        sha: "base",
        parents: [],
        commitCol: 0,
        commitColor: graph.GRAPH_REF_COLORS.local,
        inputLanes: [
          { id: "base", color: graph.GRAPH_REF_COLORS.local },
          { id: "base", color: graph.GRAPH_REF_COLORS.remote },
        ],
        outputLanes: [],
        isHead: false,
        isMerge: false,
      },
    ]);
  });

  test(`${surface} git graph inserts VS Code incoming and outgoing change rows`, () => {
    const result = graph.computeGitGraph(
      [
        { sha: "a", parents: ["b"], refs: ["origin/main"] },
        { sha: "b", parents: ["e"] },
        { sha: "c", parents: ["d"], refs: ["main"] },
        { sha: "d", parents: ["e"] },
        { sha: "e", parents: ["f"] },
        { sha: "f", parents: ["g"] },
      ],
      {
        currentRef: "main",
        remoteRef: "origin/main",
        showRemoteChangeMarkers: true,
        ahead: 2,
        behind: 2,
      },
    );

    assert.equal(result.maxCols, 2);
    assert.deepEqual(
      result.rows.map((row) => row.kind),
      [
        "commit",
        "commit",
        "outgoing-changes",
        "commit",
        "commit",
        "incoming-changes",
        "commit",
        "commit",
      ],
    );

    const outgoing = result.rows[2];
    assert.equal(outgoing.sha, graph.GIT_GRAPH_OUTGOING_CHANGES_ID);
    assert.deepEqual(outgoing.parents, ["c"]);
    assert.equal(outgoing.commitCol, 1);
    assert.deepEqual(outgoing.inputLanes, [{ id: "e", color: graph.GRAPH_REF_COLORS.remote }]);
    assert.deepEqual(outgoing.outputLanes, [
      { id: "e", color: graph.GRAPH_REF_COLORS.remote },
      { id: "c", color: graph.GRAPH_REF_COLORS.local },
    ]);

    const head = result.rows[3];
    assert.equal(head.sha, "c");
    assert.equal(head.isHead, true);
    assert.deepEqual(head.inputLanes, [
      { id: "e", color: graph.GRAPH_REF_COLORS.remote },
      { id: "c", color: graph.GRAPH_REF_COLORS.local },
    ]);

    const incoming = result.rows[5];
    assert.equal(incoming.sha, graph.GIT_GRAPH_INCOMING_CHANGES_ID);
    assert.deepEqual(incoming.parents, ["e"]);
    assert.equal(incoming.commitCol, 0);
    assert.deepEqual(incoming.inputLanes, [
      { id: graph.GIT_GRAPH_INCOMING_CHANGES_ID, color: graph.GRAPH_REF_COLORS.remote },
      { id: "e", color: graph.GRAPH_REF_COLORS.local },
    ]);
    assert.deepEqual(incoming.outputLanes, [
      { id: "e", color: graph.GRAPH_REF_COLORS.remote },
      { id: "e", color: graph.GRAPH_REF_COLORS.local },
    ]);
  });

  test(`${surface} git graph keeps an already-active merge parent as a new VS Code lane`, () => {
    const result = graph.computeGitGraph([
      { sha: "tip", parents: ["merge", "side"] },
      { sha: "merge", parents: ["base", "side"] },
    ]);

    assert.equal(result.maxCols, 3);
    assert.deepEqual(simplifyRows(result.rows), [
      {
        sha: "tip",
        parents: ["merge", "side"],
        commitCol: 0,
        commitColor: 0,
        inputLanes: [],
        outputLanes: [
          { id: "merge", color: 0 },
          { id: "side", color: 1 },
        ],
        isHead: true,
        isMerge: true,
      },
      {
        sha: "merge",
        parents: ["base", "side"],
        commitCol: 0,
        commitColor: 0,
        inputLanes: [
          { id: "merge", color: 0 },
          { id: "side", color: 1 },
        ],
        outputLanes: [
          { id: "base", color: 0 },
          { id: "side", color: 1 },
          { id: "side", color: 2 },
        ],
        isHead: false,
        isMerge: true,
      },
    ]);
  });

  test(`${surface} git graph keeps current and base refs separate around an upstream merge`, () => {
    const result = graph.computeGitGraph(
      [
        { sha: "features-tip", parents: ["feature-work"], refs: ["features", "origin/features"] },
        { sha: "feature-work", parents: ["restore-recent"] },
        {
          sha: "merge-52",
          parents: ["merge-51", "feature-work"],
          refs: ["origin/main"],
        },
        { sha: "restore-recent", parents: ["merge-51"] },
        { sha: "merge-51", parents: ["main-parent", "sidebar"] },
      ],
      {
        currentRef: "features",
        remoteRef: "origin/features",
        baseRef: "origin/main",
      },
    );

    assert.equal(result.maxCols, 3);
    const rows = simplifyRows(result.rows);
    const merge52 = rows.find((row) => row.sha === "merge-52");
    assert.deepEqual(merge52, {
      sha: "merge-52",
      parents: ["merge-51", "feature-work"],
      commitCol: 1,
      commitColor: graph.GRAPH_REF_COLORS.base,
      inputLanes: [{ id: "restore-recent", color: graph.GRAPH_REF_COLORS.local }],
      outputLanes: [
        { id: "restore-recent", color: graph.GRAPH_REF_COLORS.local },
        { id: "merge-51", color: graph.GRAPH_REF_COLORS.base },
        { id: "feature-work", color: 0 },
      ],
      isHead: false,
      isMerge: true,
    });

    const restoreRecent = rows.find((row) => row.sha === "restore-recent");
    assert.equal(restoreRecent.commitCol, 0);
    assert.equal(restoreRecent.commitColor, graph.GRAPH_REF_COLORS.local);
    assert.deepEqual(restoreRecent.inputLanes, [
      { id: "restore-recent", color: graph.GRAPH_REF_COLORS.local },
      { id: "merge-51", color: graph.GRAPH_REF_COLORS.base },
      { id: "feature-work", color: 0 },
    ]);
  });

  test(`${surface} git graph normalizes duplicate parent ids`, () => {
    const result = graph.computeGitGraph([{ sha: "m", parents: ["a", "a", "b", ""] }]);

    assert.deepEqual(result.rows[0].parents, ["a", "b"]);
    assert.deepEqual(result.rows[0].outputLanes, [
      { id: "a", color: 0 },
      { id: "b", color: 1 },
    ]);
  });
}

test("GUI and WebUI git graph modules stay in parity", () => {
  const commits = [
    { sha: "m", parents: ["a", "b"] },
    { sha: "a", parents: ["r"] },
    { sha: "b", parents: ["r"] },
    { sha: "r", parents: [] },
  ];

  assert.deepEqual(
    graphModules.gui.computeGitGraph(commits),
    graphModules.web.computeGitGraph(commits),
  );
});
