// Ad-hoc CDP evaluator against the probe page that is already open in the
// headless browser on CDP_PORT. Never navigates, so the page state (rows,
// follow state, logs) survives between calls.
//
//   node test/browser/scroll-follow-probe.eval.mjs "<js expression>"
//
// The expression is evaluated with returnByValue + awaitPromise and printed as
// JSON. Wrap DOM-heavy inspection in an IIFE that returns plain data.
const PORT = Number(process.env.CDP_PORT ?? 9333);
const expression = process.argv.slice(2).join(" ");
if (!expression) {
  console.error("usage: node scroll-follow-probe.eval.mjs '<expression>'");
  process.exit(2);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getPageTarget() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await response.json();
      const page =
        targets.find((target) => target.type === "page" && /scroll-follow-probe/.test(target.url)) ??
        targets.find((target) => target.type === "page");
      if (page) return page;
    } catch {}
    await sleep(250);
  }
  throw new Error(`no CDP page target on port ${PORT}`);
}

const target = await getPageTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});
const reply = new Promise((resolve) => {
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id === 1) resolve(message);
  });
});
ws.send(
  JSON.stringify({
    id: 1,
    method: "Runtime.evaluate",
    params: { expression, returnByValue: true, awaitPromise: true },
  }),
);
const message = await reply;
ws.close();
if (message.error) {
  console.error(JSON.stringify(message.error, null, 2));
  process.exit(1);
}
if (message.result.exceptionDetails) {
  console.error(JSON.stringify(message.result.exceptionDetails, null, 2).slice(0, 2000));
  process.exit(1);
}
console.log(JSON.stringify(message.result.result.value, null, 2));
