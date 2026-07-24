import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sourceRoots = [
  new URL("../../src/components/chat/", import.meta.url),
  new URL("../../../agent-gateway/web/src/components/chat/", import.meta.url),
];

function source(root) {
  return readFileSync(new URL("MentionComposer.tsx", root), "utf8");
}

function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const end = src.indexOf("\n}\n", start);
  assert.notEqual(end, -1, `unterminated function ${name}`);
  return src.slice(start, end + 3);
}

function loadCoversQuery(src) {
  const body = extractFunction(src, "mentionSnapshotCoversQuery").replace(
    /\(\s*fetched[^)]*\)\s*:\s*boolean/s,
    "(fetched, trigger, normalizedQuery)",
  );
  return new Function(`${body}; return mentionSnapshotCoversQuery;`)();
}

test("both composers share the snapshot-coverage decision byte-identically", () => {
  const bodies = sourceRoots.map((root) =>
    extractFunction(source(root), "mentionSnapshotCoversQuery"),
  );
  assert.equal(bodies[0], bodies[1]);
});

test("a truncated snapshot never claims to cover an extended query", () => {
  for (const root of sourceRoots) {
    const coversQuery = loadCoversQuery(source(root));

    // Complete snapshots narrow client-side, exactly as before.
    const complete = { trigger: "file", query: "", truncated: false };
    assert.equal(coversQuery(complete, "file", ""), true);
    assert.equal(coversQuery(complete, "file", "src/app"), true);
    assert.equal(coversQuery(complete, "skill", "src/app"), false);

    // The big-workspace regression: an empty-query snapshot capped by the
    // backend must refetch for every non-empty query instead of filtering
    // the incomplete cache.
    const truncated = { trigger: "file", query: "", truncated: true };
    assert.equal(coversQuery(truncated, "file", ""), true);
    assert.equal(coversQuery(truncated, "file", "s"), false);
    assert.equal(coversQuery(truncated, "file", "settings.rs"), false);

    // Query edits that stop extending the fetched query always refetch.
    const scoped = { trigger: "file", query: "src/", truncated: false };
    assert.equal(coversQuery(scoped, "file", "src/main"), true);
    assert.equal(coversQuery(scoped, "file", "sr"), false);

    // No snapshot yet means nothing to refetch against.
    assert.equal(coversQuery(null, "file", "anything"), true);
  }
});

test("both composers wire truncation tracking and debounced refetches", () => {
  for (const root of sourceRoots) {
    const composer = source(root);
    // The fetch snapshot starts pessimistic and is corrected by the response.
    assert.match(composer, /truncated: isFileFetch,/);
    assert.match(
      composer,
      /mentionFetchRef\.current = \{ \.\.\.mentionFetchRef\.current, truncated: resp\.truncated \}/,
    );
    // Query-driven file refetches are debounced and keep the current entries
    // so the popup does not flash empty between keystrokes.
    assert.match(composer, /const MENTION_REFETCH_DEBOUNCE_MS = 150;/);
    assert.match(composer, /startMentionSession\(ctx, \{ keepEntries: true \}\)/);
    // While a refetch is pending the popup reports loading instead of a
    // premature "no matching files".
    assert.match(
      composer,
      /const popupLoading = mentionSessionLoading \|\| mentionRefetchPending;/,
    );
  }
});
