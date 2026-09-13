import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(new URL("../../web/package.json", import.meta.url));
const { JSDOM, VirtualConsole } = require("jsdom");
const runtime = readFileSync(new URL("../../internal/server/tunnel_runtime.js", import.meta.url), "utf8");
const prefix = "/t/runtime-test";

async function fixture(t) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    if (!req.url.startsWith(`${prefix}/`)) {
      res.writeHead(404).end("wrong root");
    } else if (req.url.includes(".js")) {
      res.writeHead(200, { "Content-Type": "text/javascript" });
      res.end('window.executed = (window.executed || 0) + 1;');
    } else if (req.url.includes(".css")) {
      res.writeHead(200, { "Content-Type": "text/css" });
      res.end("body { border-top-width: 7px; }");
    } else {
      res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
    url: `${origin}${prefix}/`,
    resources: "usable",
    runScripts: "dangerously",
    virtualConsole: new VirtualConsole(),
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  const nativeSetAttribute = window.Element.prototype.setAttribute;
  window.Request = Request;
  window.fetch = fetch;
  window.eval(`${runtime}(${JSON.stringify({ basePath: prefix })});`);
  return { window, document: window.document, requests, origin, nativeSetAttribute };
}

function loaded(element) {
  return new Promise((resolve, reject) => {
    element.onload = resolve;
    element.onerror = () => reject(new Error(`resource failed: ${element.src || element.href}`));
  });
}

test("dynamic scripts load and execute through the tunnel for native URL assignment paths", { timeout: 10000 }, async (t) => {
  const { window, document, requests, origin } = await fixture(t);
  const variants = [
    (script) => { script.src = "/property.js"; },
    (script) => { script.setAttribute("src", "/attribute.js?version=2"); },
    (script) => { script.setAttribute("SRC", "/uppercase.js"); },
    (script) => { script.setAttributeNS(null, "src", "/namespace.js"); },
    (script) => { script.src = `${origin}/absolute.js`; },
    (script) => { script.src = `//${new URL(origin).host}/protocol-relative.js`; },
  ];
  for (const connected of [false, true]) {
    for (const assign of variants) {
      const script = document.createElement("script");
      const done = loaded(script);
      if (connected) document.head.append(script);
      assign(script);
      if (!connected) document.head.appendChild(script);
      await done;
    }
  }
  assert.equal(window.executed, variants.length * 2);
  assert.equal(requests.length, variants.length * 2);
  assert.ok(requests.every((url) => url.startsWith(`${prefix}/`)), requests.join("\n"));
  assert.ok(requests.includes(`${prefix}/attribute.js?version=2`));
});

test("dynamic stylesheets load via properties, attributes and detached HTML fragments", { timeout: 10000 }, async (t) => {
  const { document, requests } = await fixture(t);
  for (const useAttribute of [false, true]) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    const done = loaded(link);
    document.head.append(link);
    if (useAttribute) link.setAttribute("href", "/attribute.css");
    else link.href = "/property.css";
    await done;
    assert.equal(link.sheet.cssRules.length, 1);
  }
  const template = document.createElement("template");
  template.innerHTML = '<link rel="stylesheet" href="/fragment.css">';
  const fragment = template.content.cloneNode(true);
  const link = fragment.firstChild;
  const done = loaded(link);
  document.head.appendChild(fragment);
  await done;
  assert.equal(link.sheet.cssRules.length, 1);
  assert.deepEqual(requests, [`${prefix}/property.css`, `${prefix}/attribute.css`, `${prefix}/fragment.css`]);
});

test("insertion APIs rewrite cloned resources before the first request", { timeout: 10000 }, async (t) => {
  const { document, requests, nativeSetAttribute } = await fixture(t);
  const insertions = [
    (node, anchor) => anchor.parentNode.appendChild(node),
    (node, anchor) => anchor.parentNode.insertBefore(node, anchor),
    (node, anchor) => anchor.parentNode.replaceChild(node, anchor),
    (node, anchor) => anchor.parentNode.append(node),
    (node, anchor) => anchor.parentNode.prepend(node),
    (node, anchor) => anchor.parentNode.replaceChildren(node),
    (node, anchor) => anchor.before(node),
    (node, anchor) => anchor.after(node),
    (node, anchor) => anchor.replaceWith(node),
    (node, anchor) => anchor.insertAdjacentElement("afterend", node),
  ];
  for (const [index, insert] of insertions.entries()) {
    const container = document.createElement("div");
    const anchor = document.createElement("span");
    container.append(anchor);
    document.body.append(container);
    const source = document.createElement("script");
    nativeSetAttribute.call(source, "src", `/clone-${index}.js`);
    const script = source.cloneNode(true);
    const done = loaded(script);
    insert(script, anchor);
    await done;
  }
  assert.equal(requests.length, insertions.length);
  assert.ok(requests.every((url) => url.startsWith(`${prefix}/clone-`)), requests.join("\n"));
});

test("resource rewriting preserves external, relative, typed and already-prefixed values", { timeout: 10000 }, async (t) => {
  const { window, document, origin } = await fixture(t);
  for (const value of [
    "./relative.js", "../relative.js", "https://cdn.example/lib.js", "//cdn.example/lib.js",
    "data:text/javascript,void 0", "blob:https://example/id", `${prefix}/existing.js?v=1#fragment`,
    `${origin}${prefix}/existing.js`,
  ]) {
    const script = document.createElement("script");
    script.src = value;
    assert.equal(script.getAttribute("src"), value);
    script.setAttribute("src", value);
    assert.equal(script.getAttribute("src"), value);
  }
  const script = document.createElement("script");
  const typedValue = { toString: () => "/typed.js" };
  script.src = typedValue;
  assert.equal(script.getAttribute("src"), "/typed.js");
  script.setAttribute("data-src", "/unrelated.js");
  assert.equal(script.getAttribute("data-src"), "/unrelated.js");
  const image = document.createElement("img");
  image.setAttribute("src", "/unchanged.png");
  assert.equal(image.getAttribute("src"), "/unchanged.png");
  const setter = Object.getOwnPropertyDescriptor(window.HTMLScriptElement.prototype, "src").set;
  window.eval(`${runtime}(${JSON.stringify({ basePath: prefix })});`);
  assert.equal(Object.getOwnPropertyDescriptor(window.HTMLScriptElement.prototype, "src").set, setter);
});

test("fetch Request and XHR still reach the target through the prefix", { timeout: 10000 }, async (t) => {
  const { window, requests, origin } = await fixture(t);
  const response = await window.fetch(new Request(`${origin}/api/health`));
  assert.deepEqual(await response.json(), { ok: true });
  await new Promise((resolve, reject) => {
    const xhr = new window.XMLHttpRequest();
    xhr.onload = () => { assert.equal(xhr.status, 200); resolve(); };
    xhr.onerror = reject;
    xhr.open("GET", "/api/xhr");
    xhr.send();
  });
  assert.deepEqual(requests, [`${prefix}/api/health`, `${prefix}/api/xhr`]);
});
