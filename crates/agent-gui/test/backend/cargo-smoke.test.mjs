import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const guiRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

const cargoMissing =
  spawnSync("cargo", ["--version"], { stdio: "ignore" }).status === 0 ? false : "cargo is not on PATH";

function runCargoTest() {
  return new Promise((resolve) => {
    const child = spawn(
      "cargo",
      ["test", "--manifest-path", "src-tauri/Cargo.toml"],
      {
        cwd: guiRoot,
        env: {
          ...process.env,
          CARGO_TERM_COLOR: "never",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

// A cold build alone takes several minutes.
test("Tauri backend cargo test suite passes", { skip: cargoMissing, timeout: 1_200_000 }, async () => {
  const result = await runCargoTest();
  assert.equal(
    result.code,
    0,
    [
      "cargo test --manifest-path src-tauri/Cargo.toml failed",
      "--- stdout ---",
      result.stdout.slice(-6000),
      "--- stderr ---",
      result.stderr.slice(-6000),
    ].join("\n"),
  );
});
