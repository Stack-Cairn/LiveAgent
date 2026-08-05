import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { mentionSnapshotCoversQuery } = loader.loadModule(
  "src/components/chat/MentionComposer.tsx",
);

test("a complete snapshot is narrowed client-side instead of refetched", () => {
  const complete = { trigger: "file", query: "", truncated: false };
  assert.equal(mentionSnapshotCoversQuery(complete, "file", ""), true);
  assert.equal(mentionSnapshotCoversQuery(complete, "file", "src/app"), true);
});

test("a snapshot fetched for another trigger never covers the query", () => {
  const complete = { trigger: "file", query: "", truncated: false };
  assert.equal(mentionSnapshotCoversQuery(complete, "skill", "src/app"), false);
});

test("a truncated snapshot never claims to cover an extended query", () => {
  // The big-workspace regression: an empty-query snapshot capped by the
  // backend must refetch for every non-empty query instead of filtering the
  // incomplete cache and reporting "no matching files".
  const truncated = { trigger: "file", query: "", truncated: true };
  assert.equal(mentionSnapshotCoversQuery(truncated, "file", ""), true);
  assert.equal(mentionSnapshotCoversQuery(truncated, "file", "s"), false);
  assert.equal(mentionSnapshotCoversQuery(truncated, "file", "settings.rs"), false);
});

test("query edits that stop extending the fetched query refetch", () => {
  const scoped = { trigger: "file", query: "src/", truncated: false };
  assert.equal(mentionSnapshotCoversQuery(scoped, "file", "src/main"), true);
  assert.equal(mentionSnapshotCoversQuery(scoped, "file", "sr"), false);
});

test("no snapshot yet means there is nothing to refetch against", () => {
  assert.equal(mentionSnapshotCoversQuery(null, "file", "anything"), true);
});
