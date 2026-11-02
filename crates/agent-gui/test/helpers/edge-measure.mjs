// 真实几何：把 jsdom 渲染出的真实组件 markup 套上构建产物 CSS，在无头 Edge 里量。
// 需要 Edge 与 crates/agent-gui/dist、crates/agent-gateway/web/dist 的构建 CSS；缺任一项时
// edgeMeasureSkip 给出跳过原因。320 = MIN_CONVERSATION_PANE_WIDTH（分屏最窄 Pane）。
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const EDGE = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
].find((p) => existsSync(p));

function distCss(relDir) {
  const dir = fileURLToPath(new URL(`../../../${relDir}/`, import.meta.url));
  if (!existsSync(dir)) return null;
  const file = readdirSync(dir).find((f) => /^index-.*\.css$/.test(f));
  return file ? pathToFileURL(join(dir, file)).href : null;
}
const GUI_CSS = distCss("agent-gui/dist/assets");
const WEB_CSS = distCss("agent-gateway/web/dist/assets");

export const edgeMeasureSkip = !EDGE || !GUI_CSS || !WEB_CSS ? "needs Edge and built dist CSS" : false;

const withTimeout = (promise, ms, what) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timeout: ${what}`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// spawn 出来的 msedge.exe 只是启动器（几十毫秒就退出），真正的无头浏览器是另一个进程，
// 只能按 --user-data-dir 找到它。
function killBrowsersUsing(profileDir) {
  if (process.platform !== "win32") return;
  const needle = profileDir.replaceAll("'", "''");
  spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${needle}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    ],
    { stdio: "ignore", timeout: 15_000 },
  );
}

/**
 * 一次启动 Edge，按顺序量完全部场景。pages: [{ key, surface: "desktop" | "web", width, html }]；
 * expression 在页面里求值，返回可序列化的结果。返回 Map<key, 结果>。
 * 结束时发 Browser.close，DevTools 连接断开即浏览器已关；没连上或等不到时按 profile 兜底结束。
 */
export async function measureInEdge(pages, expression) {
  const results = new Map();
  const dir = mkdtempSync(join(tmpdir(), "edge-measure-"));
  const profile = join(dir, "profile");
  const edge = spawn(
    EDGE,
    [
      "--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions",
      "--allow-file-access-from-files", `--user-data-dir=${profile}`,
      "--remote-debugging-port=0", "about:blank",
    ],
    { stdio: "ignore" },
  );
  let ws;
  try {
    const portFile = join(profile, "DevToolsActivePort");
    for (let i = 0; i < 150 && !existsSync(portFile); i += 1) await sleep(100);
    const [port, browserPath] = readFileSync(portFile, "utf8").trim().split(/\s+/);
    ws = new WebSocket(`ws://127.0.0.1:${port}${browserPath}`);
    await withTimeout(new Promise((r) => ws.addEventListener("open", r)), 10_000, "ws open");
    let id = 0;
    const pending = new Map();
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
      }
    });
    const send = (method, params = {}, sessionId) =>
      withTimeout(
        new Promise((res) => {
          const i = ++id;
          pending.set(i, res);
          ws.send(JSON.stringify({ id: i, method, params, sessionId }));
        }),
        10_000,
        method,
      );
    const { result: target } = await send("Target.createTarget", { url: "about:blank" });
    const { result: attached } = await send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    const sid = attached.sessionId;
    for (const [index, page] of pages.entries()) {
      const web = page.surface === "web";
      const file = join(dir, `page-${index}.html`);
      writeFileSync(
        file,
        `<!doctype html><html ${web ? 'data-liveagent-webui="gateway"' : ""}><head><meta charset="utf-8"><link rel="stylesheet" href="${web ? WEB_CSS : GUI_CSS}"></head><body style="margin:0"><div class="${web ? "gateway-chat-frame" : ""}" style="position:relative;width:100vw;height:100vh">${page.html}</div></body></html>`,
      );
      await send("Emulation.setDeviceMetricsOverride", { width: page.width, height: 900, deviceScaleFactor: 1, mobile: false }, sid);
      const url = pathToFileURL(file).href;
      await send("Page.navigate", { url }, sid);
      for (let i = 0; i < 100; i += 1) {
        const ready = await send("Runtime.evaluate", { expression: `location.href === ${JSON.stringify(url)} && document.readyState === 'complete' && document.styleSheets.length > 0`, returnByValue: true }, sid);
        if (ready.result?.result?.value) break;
        await sleep(50);
      }
      const out = await send("Runtime.evaluate", { expression, returnByValue: true }, sid);
      if (out.result?.exceptionDetails) {
        throw new Error(`${page.key}: ${out.result.exceptionDetails.exception?.description ?? "evaluate failed"}`);
      }
      results.set(page.key, out.result.result.value);
    }
  } finally {
    const connected = ws?.readyState === WebSocket.OPEN;
    const closed = connected
      ? new Promise((r) => ws.addEventListener("close", r, { once: true }))
      : null;
    try {
      if (connected) ws.send(JSON.stringify({ id: 1e9, method: "Browser.close" }));
    } catch {}
    const browserClosed = closed
      ? await withTimeout(closed, 8_000, "browser close").then(
          () => true,
          () => false,
        )
      : false;
    if (!browserClosed) {
      edge.kill();
      killBrowsersUsing(profile);
    }
    ws?.close();
    await sleep(500);
    // 删不掉临时目录不能盖住测量本身的错误。
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {}
  }
  return results;
}
