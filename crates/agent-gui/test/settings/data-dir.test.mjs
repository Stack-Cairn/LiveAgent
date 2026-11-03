import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { dataDirTargetFor } = loader.loadModule("src/lib/system/dataDir.ts");

test("data dir target creates a LiveAgent folder inside the picked directory", () => {
  assert.equal(dataDirTargetFor("/Volumes/Data", "/Users/a/.liveagent"), "/Volumes/Data/LiveAgent");
  assert.equal(dataDirTargetFor("D:\\", "C:\\Users\\a\\.liveagent"), "D:\\LiveAgent");
  assert.equal(dataDirTargetFor("D:\\Apps\\", "C:\\Users\\a\\.liveagent"), "D:\\Apps\\LiveAgent");
});

test("picking an existing LiveAgent folder uses it directly", () => {
  assert.equal(
    dataDirTargetFor("/Volumes/Data/LiveAgent/", "/Users/a/.liveagent"),
    "/Volumes/Data/LiveAgent",
  );
});
