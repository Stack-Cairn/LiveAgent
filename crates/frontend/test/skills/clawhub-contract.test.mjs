import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const clawHub = loader.loadModule("src/lib/skills/clawHub.ts");

test("normalizes current ClawHub list and search response shapes", () => {
  const listCard = clawHub.normalizeClawHubSkillCard({
    slug: "github",
    displayName: "Github",
    summary: "GitHub CLI workflows",
    latestVersion: { version: "1.0.0" },
    stats: { downloads: 193172, stars: 652, installs: 7621 },
    updatedAt: 1781268517834,
  });
  const searchCard = clawHub.normalizeClawHubSkillCard({
    slug: "github",
    displayName: "Github",
    summary: "GitHub CLI workflows",
    version: "1.0.0",
    downloads: 193172,
    updatedAt: 1781268517834,
    ownerHandle: "steipete",
    owner: { handle: "steipete", displayName: "Peter Steinberger" },
  });

  assert.equal(listCard.ownerHandle, null);
  assert.equal(listCard.downloads, 193172);
  assert.equal(listCard.installsCurrent, 7621);
  assert.equal(searchCard.ownerHandle, "steipete");
  assert.equal(searchCard.latestVersion, "1.0.0");
  assert.equal(searchCard.downloads, 193172);
  assert.match(searchCard.downloadUrl, /ownerHandle=steipete/);
});

test("selects the publisher matching the unscoped catalog card", () => {
  const catalogCard = clawHub.normalizeClawHubSkillCard({
    slug: "github",
    displayName: "Github",
    summary: "GitHub CLI workflows",
    latestVersion: { version: "1.0.0" },
    stats: { downloads: 193172 },
    updatedAt: 1781268517834,
  });
  const candidates = [
    {
      ...catalogCard,
      ownerHandle: "steipete",
      updatedAt: 1781268517834,
    },
    {
      ...catalogCard,
      ownerHandle: "eohmig",
      downloads: 8,
      updatedAt: 1782439133368,
    },
  ];

  const selected = clawHub.selectClawHubOwnerCandidate(catalogCard, candidates);

  assert.equal(selected.ownerHandle, "steipete");
});

test("uses publisher and slug as the store identity", () => {
  assert.notEqual(
    clawHub.buildClawHubSkillKey({ slug: "github", ownerHandle: "steipete" }),
    clawHub.buildClawHubSkillKey({ slug: "github", ownerHandle: "eohmig" }),
  );
  assert.equal(
    clawHub.buildClawHubSkillKey({ slug: "GitHub", ownerHandle: "@STEIPETE" }),
    "clawhub:steipete/github",
  );
});
