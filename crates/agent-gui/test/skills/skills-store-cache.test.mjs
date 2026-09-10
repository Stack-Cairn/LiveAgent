import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const hubSource = readFileSync(
  new URL("../../../agent-ui/src/pages/skills-hub/SkillsHubPage.tsx", import.meta.url),
  "utf8",
);
const storeSource = readFileSync(
  new URL("../../../agent-ui/src/pages/skills-hub/SkillsStoreView.tsx", import.meta.url),
  "utf8",
);
const cacheSource = readFileSync(
  new URL("../../../agent-ui/src/pages/skills-hub/skillStoreCache.ts", import.meta.url),
  "utf8",
);

test("the skill store reuses a fresh catalog snapshot when returning to the tab", () => {
  assert.match(hubSource, /const cached = readSkillStoreCatalog\(cacheKey\)/);
  assert.match(
    hubSource,
    /setStoreItems\(cached\?\.items \?\? \[\]\)[\s\S]*cached && isSkillStoreCatalogFresh\(cached\)/,
  );
  assert.match(cacheSource, /const catalogRequests = new Map/);
  assert.match(cacheSource, /if \(existingRequest\) return existingRequest/);
});

test("the skill store appends the next cursor page instead of refetching the full list", () => {
  assert.match(
    cacheSource,
    /listClawHubSkills\(\{[\s\S]*sort: params\.sort,[\s\S]*cursor: params\.cursor,[\s\S]*limit: params\.limit/,
  );
  assert.match(hubSource, /loadMoreSkillStoreCatalog\(\{[\s\S]*cursor: storeCursor/);
  assert.doesNotMatch(hubSource, /limit:\s*storeItems\.length\s*\+/);
});

test("an opened skill detail is shown from cache and refreshed only when stale", () => {
  assert.match(storeSource, /const cached = readSkillStoreDetail\(previewSkill\)/);
  assert.match(storeSource, /setPreviewDetail\(cached\?\.detail \?\? null\)/);
  assert.match(storeSource, /setPreviewLoading\(!cached\)/);
  assert.match(storeSource, /cached && isSkillStoreDetailFresh\(cached, previewSkill\)/);
  assert.match(cacheSource, /const detailRequests = new Map/);
  assert.match(
    cacheSource,
    /writeLruEntry\(detailCache, initialKey[\s\S]*buildClawHubSkillKey\(snapshot\.skill\)/,
  );
});

test("background catalog refresh does not move the tabs or disable the card grid", () => {
  assert.match(storeSource, /absolute inset-x-0 -bottom-1 h-px/);
  assert.match(storeSource, /w-\[42%\] origin-left animate-hub-loading-progress motion-reduce:animate-none! h-full rounded-full bg-foreground\/45/);
  assert.doesNotMatch(storeSource, /Loader2 aria-hidden=\{!refreshing\}/);
  assert.doesNotMatch(storeSource, /blur-\[1px\]/);
  assert.doesNotMatch(storeSource, /pointer-events-none saturate/);
});

test("store cards keep a static surface on pointer hover", () => {
  assert.doesNotMatch(storeSource, /hover:shadow-md/);
  assert.doesNotMatch(storeSource, /hover:-translate-y/);
  assert.doesNotMatch(storeSource, /group-hover:bg-muted\/80/);
});

test("store cards keep the spacious original information hierarchy", () => {
  assert.match(storeSource, /flex h-full cursor-pointer flex-col rounded-2xl/);
  assert.match(storeSource, /line-clamp-3 text-11p5px/);
  assert.match(storeSource, /border-t border-border\/60 pt-2 text-10p5px/);
  assert.match(storeSource, /mt-auto h-9 w-full gap-1\.5 rounded-xl/);
  assert.doesNotMatch(storeSource, /w-fit self-end/);
});
