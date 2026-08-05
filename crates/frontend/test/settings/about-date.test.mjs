import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

process.env.TZ = "UTC";

const loader = createTsModuleLoader();
const { formatReleaseDate } = loader.loadModule("src/pages/settings/aboutDate.ts");

test("formats updater release dates without seconds, milliseconds, or timezone", () => {
  assert.equal(formatReleaseDate("2026-06-21 9:26:56.441 +00:00:00"), "2026-06-21 09:26");
  assert.equal(formatReleaseDate("2026-06-21T09:26:56.441Z"), "2026-06-21 09:26");
});

test("keeps unknown release date values readable", () => {
  assert.equal(formatReleaseDate("  not-a-date  "), "not-a-date");
  assert.equal(formatReleaseDate(null), "");
});
