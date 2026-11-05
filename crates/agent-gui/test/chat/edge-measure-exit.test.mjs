import assert from "node:assert/strict";
import test from "node:test";
import { edgeMeasureSkip as skip, measureInEdge } from "../helpers/edge-measure.mjs";

// Windows 上 spawn 出来的 msedge.exe 只是启动器，几十毫秒就退出，真正的无头浏览器是另一个进程。
// 以前 finally 等启动器的 exit 事件，事件早已错过，每次调用都白等 8s 超时。
// 这里只量浏览器关闭之后的收尾耗时，不量总耗时：机器忙的时候启动 Edge 可能超过任何固定上限，
// 而收尾只有 0.5s 等待和删临时目录，不受负载影响。
test("measureInEdge returns promptly after a one-page run instead of waiting out the exit timeout", { skip }, async () => {
  let browserClosed;
  let closedAt;
  const results = await measureInEdge(
    [{ key: "k", surface: "web", width: 320, html: "<p>x</p>" }],
    "1 + 1",
    (closed) => {
      browserClosed = closed;
      closedAt = Date.now();
    },
  );
  const cleanup = Date.now() - closedAt;
  assert.equal(results.get("k"), 2);
  assert.equal(browserClosed, true, "the browser should close on request, not wait out the timeout");
  assert.ok(cleanup < 6000, `cleanup after the browser closed took ${cleanup}ms`);
});
