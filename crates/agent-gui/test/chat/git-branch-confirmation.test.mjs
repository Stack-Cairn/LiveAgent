import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const source = readFileSync(new URL("../../../agent-ui/src/components/git/GitBranchSelector.tsx", import.meta.url), "utf8");
const body = source.match(/const selectBranch = useCallback\(\s*async \(branch: GitBranchInfo\) => \{([\s\S]*?)\n    \},/)[1];
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const execute = new AsyncFunction("branch", "gitClient", "canWrite", "mutating", "handleMenuOpenChange", "confirm", "t", "workdir", "runBranchMutation", body);

test("branch selection waits for confirmation and cancel performs no Git mutation", async () => {
  const calls = [];
  const branch = { fullName: "feature/$demo", kind: "local", current: false };
  const client = { switchBranch: (...args) => calls.push(args) };
  const run = answer => execute(branch, client, true, false, () => {}, async options => {
    assert.equal(calls.length, 0);
    assert.equal(options.detail, "/repo");
    return answer;
  }, key => key, "/repo", task => task());
  await run(false);
  assert.deepEqual(calls, []);
  await run(true);
  assert.deepEqual(calls, [["/repo", "feature/$demo", "local"]]);
});

test("current branch and read-only state do not request confirmation", async () => {
  const fail = () => assert.fail("must not confirm or mutate");
  for (const [current, canWrite] of [[true, true], [false, false]]) {
    await execute({ current }, {}, canWrite, false, fail, fail, fail, "/repo", fail);
  }
});
