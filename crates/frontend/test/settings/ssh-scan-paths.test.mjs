import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const scan = loader.loadModule("src/lib/ssh/scan.ts");

test("expandIdentityPath supports Windows SSH identity paths", () => {
  const home = "C:\\Users\\Alice";

  assert.equal(scan.expandIdentityPath(home, "~\\keys\\id_ed25519"), "C:\\Users\\Alice\\keys\\id_ed25519");
  assert.equal(scan.expandIdentityPath(home, "%USERPROFILE%\\.ssh\\id_rsa"), "C:\\Users\\Alice\\.ssh\\id_rsa");
  assert.equal(scan.expandIdentityPath(home, "%HOMEDRIVE%%HOMEPATH%\\.ssh\\id_rsa"), "C:\\Users\\Alice\\.ssh\\id_rsa");
  assert.equal(scan.expandIdentityPath(home, "C:\\Keys\\prod key"), "C:\\Keys\\prod key");
  assert.equal(scan.expandIdentityPath(home, "C:Keys\\id_rsa"), "C:\\Users\\Alice\\C:Keys\\id_rsa");
  assert.equal(scan.expandIdentityPath(home, "\\\\server\\share\\id_rsa"), "\\\\server\\share\\id_rsa");
  assert.equal(scan.expandIdentityPath(home, "\\\\?\\C:\\Keys\\id_rsa"), "\\\\?\\C:\\Keys\\id_rsa");
});

test("expandIdentityPath preserves POSIX path semantics", () => {
  const home = "/Users/alice";

  assert.equal(scan.expandIdentityPath(home, "~/keys/id_ed25519"), "/Users/alice/keys/id_ed25519");
  assert.equal(scan.expandIdentityPath(home, "$HOME/.ssh/id_rsa"), "/Users/alice/.ssh/id_rsa");
  assert.equal(scan.expandIdentityPath(home, "${HOME}/.ssh/id_rsa"), "/Users/alice/.ssh/id_rsa");
  assert.equal(scan.expandIdentityPath(home, "/opt/keys/id_rsa"), "/opt/keys/id_rsa");
  assert.equal(scan.expandIdentityPath(home, "dir\\key"), "/Users/alice/dir\\key");
  assert.equal(scan.expandIdentityPath(home, "C:\\Keys\\id_rsa"), "/Users/alice/C:\\Keys\\id_rsa");
});
