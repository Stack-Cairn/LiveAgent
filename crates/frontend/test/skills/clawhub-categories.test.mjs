import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const categories = loader.loadModule("src/lib/skills/clawHubCategories.ts");

function classify(card) {
  return categories.classifyClawHubSkill({
    slug: card.slug ?? "test-skill",
    displayName: card.displayName ?? "Test Skill",
    summary: card.summary ?? "",
    topics: card.topics ?? [],
  });
}

test("exposes the ClawHub category taxonomy", () => {
  assert.equal(categories.CLAWHUB_CATEGORY_SLUGS.length, 14);
  assert.ok(categories.CLAWHUB_CATEGORY_SLUGS.includes("lifestyle"));
  assert.ok(categories.CLAWHUB_CATEGORY_SLUGS.includes("other"));
});

test("classifies a communication/integration skill from topics and summary", () => {
  const result = classify({
    slug: "gog",
    displayName: "Gog",
    summary: "Google Workspace CLI for Gmail, Calendar, Drive, Contacts, Sheets, and Docs.",
    topics: ["Gmail", "Calendar", "Docs"],
  });
  assert.ok(result.includes("communication"), `expected communication in ${result}`);
  assert.ok(result.length <= 3);
});

test("ranks security first for a vetting skill", () => {
  const result = classify({
    slug: "skill-vetter",
    displayName: "Skill Vetter",
    summary: "Security-first skill vetting for AI agents. Use before installing any skill.",
    topics: ["GitHub", "Permission"],
  });
  assert.equal(result[0], "security");
});

test("classifies lifestyle skills", () => {
  const result = classify({
    slug: "sonoscli",
    displayName: "Sonoscli",
    summary: "Control Sonos speakers (discover/status/play/volume/group).",
    topics: ["smart-home"],
  });
  assert.ok(result.includes("lifestyle"), `expected lifestyle in ${result}`);
});

test("falls back to other when nothing matches", () => {
  const result = classify({
    slug: "zzzz",
    displayName: "Zzzz",
    summary: "Qwerty asdf.",
    topics: [],
  });
  assert.deepEqual(result, ["other"]);
});

test("topic matches outweigh summary matches", () => {
  const result = classify({
    slug: "mixed",
    displayName: "Mixed",
    // summary 命中 research(search)，topics 命中 finance(stocks)——finance 应排前。
    summary: "Search helper.",
    topics: ["stocks"],
  });
  assert.equal(result[0], "finance");
});

test("caps the number of categories per skill", () => {
  const result = classify({
    slug: "kitchen-sink",
    displayName: "Kitchen Sink",
    summary:
      "Email calendar notes github docker security stocks health image agent memory search cron api",
    topics: ["Gmail", "GitHub", "Docker"],
  });
  assert.ok(result.length <= 3, `expected at most 3 categories, got ${result.length}`);
  assert.ok(!result.includes("other"));
});
