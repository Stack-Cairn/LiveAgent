import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  cpSync,
  existsSync,
  mkdtempSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url)),
  args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i < 0 ? fallback : args[i + 1];
};
const sourceRoot = resolve(option("--source", root)),
  out = resolve(option("--out", mkdtempSync(join(tmpdir(), "liveagent-style-")))),
  baseline = option("--baseline", null);
const require = createRequire(new URL("../crates/agent-gui/package.json", import.meta.url));
if (baseline && resolve(baseline) === out)
  throw new Error("The baseline and output directories must differ.");
mkdirSync(out, { recursive: true });
const result = await require("esbuild").build({
  entryPoints: [resolve(option("--entry", join(root, "scripts/style-preview/client.tsx")))],
  bundle: true,
  format: "esm",
  jsx: "automatic",
  write: false,
  define: { "process.env.NODE_ENV": '"production"' },
  alias: {
    react: dirname(require.resolve("react/package.json")),
    "react-dom": dirname(require.resolve("react-dom/package.json")),
  },
  plugins: [
    {
      name: "fixture-source",
      setup(build) {
        build.onResolve({ filter: /^\.\.\/\.\.\/crates\/agent-ui\// }, (args) => ({
          path: resolve(sourceRoot, args.path.replace(/^\.\.\/\.\.\//, "")) + ".tsx",
        }));
      },
    },
  ],
});
writeFileSync(join(out, "client.js"), result.outputFiles[0].text);
const fonts = join(sourceRoot, "crates/agent-ui/src/assets/font");
if (existsSync(fonts)) cpSync(fonts, join(out, "fonts"), { recursive: true });
for (const [host, rel] of [
  ["gui", "crates/agent-gui"],
  ["web", "crates/agent-gateway/web"],
]) {
  const req = createRequire(join(root, rel, "package.json")),
    from = join(sourceRoot, rel, "src/index.css");
  const css = await req("postcss")([req("@tailwindcss/postcss")({ optimize: false })]).process(
    readFileSync(from, "utf8") +
      '\n@source "' +
      join(root, "scripts/style-preview/client.tsx") +
      '";\n@source "' +
      join(sourceRoot, "crates/agent-ui/src") +
      '";',
    { from },
  );
  let text = css.css;
  if (host === "web")
    for (const file of ["base-chat", "login", "responsive", "status-board"])
      text += "\n" + readFileSync(join(sourceRoot, rel, "src/styles", file + ".css"), "utf8");
  text = text.replace(
    /url\((['"]?)[^)]*\/([^/)'" ]+\.woff2?)\1\)/g,
    (_, quote, name) => `url("fonts/${name}")`,
  );
  writeFileSync(join(out, host + ".css"), text);
}
writeFileSync(
  join(out, "snapshot.json"),
  JSON.stringify(
    { createdAt: new Date().toISOString(), sourceRoot, files: ["client.js", "gui.css", "web.css"] },
    null,
    2,
  ),
);
console.log("Style snapshot:", out);
if (args.includes("--no-serve")) process.exit(0);
if (baseline && !existsSync(join(resolve(baseline), "snapshot.json")))
  throw Error("Baseline must be a style:preview snapshot directory.");
const frame = String.raw`<!doctype html><meta charset="utf-8"><script>const p=new URLSearchParams(location.search);if(p.get('host')==='web')document.documentElement.dataset.liveagentWebui='gateway';if(p.get('theme')==='dark')document.documentElement.classList.add('dark');</script><link rel="stylesheet" href="style.css"><style>body{margin:0}main{padding:16px;display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}section[data-case]{min-width:0}h2{font:12px sans-serif;margin:0 0 8px;opacity:.65}[data-sample]{min-height:48px}</style><div id="root"></div><script type="module" src="client.js"></script>`;
const page = readFileSync(new URL("./style-preview/compare.html", import.meta.url), "utf8").replace(
  "__BASELINE__",
  JSON.stringify(Boolean(baseline)),
);
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://localhost"),
    isBefore = url.pathname.startsWith("/before/"),
    dir = isBefore && baseline ? resolve(baseline) : out;
  if (url.pathname === "/") {
    response.setHeader("Content-Type", "text/html");
    response.end(page);
    return;
  }
  const file = url.pathname.split("/").slice(2).join("/");
  if (file === "frame.html") {
    response.setHeader("Content-Type", "text/html");
    response.end(
      frame.replace(
        'href="style.css"',
        'href="style.css' + url.search.replaceAll("&", "&amp;") + '"',
      ),
    );
    return;
  }
  if (file === "style.css") {
    response.setHeader("Content-Type", "text/css");
    let css = readFileSync(
      join(dir, url.searchParams.get("host") === "web" ? "web.css" : "gui.css"),
      "utf8",
    );
    const reduced = url.searchParams.get("reduced") === "true";
    css = css.replaceAll(
      "(prefers-reduced-motion: reduce)",
      reduced ? "(min-width: 0px)" : "(max-width: -1px)",
    );
    response.end(css);
    return;
  }
  if (file === "client.js" || /^fonts\/[\w.-]+\.(woff2?|ttf)$/.test(file)) {
    const path = join(dir, file);
    if (existsSync(path)) {
      response.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : "font/woff2");
      response.end(readFileSync(path));
      return;
    }
  }
  response.statusCode = 404;
  response.end("Not found");
});
server.listen(Number(option("--port", "0")), "127.0.0.1", () =>
  console.log("Style preview: http://127.0.0.1:" + server.address().port),
);
