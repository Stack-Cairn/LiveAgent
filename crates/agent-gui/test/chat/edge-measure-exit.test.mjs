import assert from "node:assert/strict";
import test from "node:test";
import { edgeMeasureSkip as skip, measureInEdge } from "../helpers/edge-measure.mjs";

// Windows 上 spawn 出来的 msedge.exe 只是启动器，几十毫秒就退出，真正的无头浏览器是另一个进程。
// 以前 finally 等启动器的 exit 事件，事件早已错过，每次调用都白等 8s 超时。
test("measureInEdge returns promptly after a one-page run instead of waiting out the exit timeout", { skip }, async () => {
  const started = Date.now();
  const results = await measureInEdge(
    [{ key: "k", surface: "web", width: 320, html: "<p>x</p>" }],
    "1 + 1",
  );
  const elapsed = Date.now() - started;
  assert.equal(results.get("k"), 2);
  // 启动 Edge + 一页导航 + 关闭，本机约 1.2s（finally 前 ~0.55s + 关闭 ~0.1s + 0.5s 等待）；8s 是 finally 里的退出等待上限。
  assert.ok(elapsed < 6000, `one trivial page took ${elapsed}ms`);
});
