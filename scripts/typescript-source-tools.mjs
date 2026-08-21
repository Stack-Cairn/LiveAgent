import { pathToFileURL } from "node:url";
import { parse } from "@babel/parser";
import { transformSync } from "esbuild";

export function parseTypeScriptSource(source, fileName) {
  const supportsJsx = /\.[cm]?[jt]sx$/i.test(fileName) && fileName.toLowerCase().endsWith("x");
  return parse(source, {
    sourceFilename: fileName,
    sourceType: "module",
    createParenthesizedExpressions: true,
    plugins: supportsJsx ? ["typescript", "jsx"] : ["typescript"],
  });
}

export function walkSyntaxTree(node, visitor) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walkSyntaxTree(child, visitor);
    return;
  }
  if (typeof node.type !== "string") return;

  visitor(node);
  for (const [key, child] of Object.entries(node)) {
    if (["comments", "errors", "extra", "loc", "tokens"].includes(key)) continue;
    walkSyntaxTree(child, visitor);
  }
}

export function staticStringValue(node) {
  if (node?.type === "StringLiteral") return node.value;
  if (node?.type !== "TemplateLiteral" || node.expressions.length > 0) return undefined;
  return node.quasis[0]?.value.cooked ?? node.quasis[0]?.value.raw;
}

function loaderFor(filePath) {
  const extension = filePath.toLowerCase().match(/\.[^.]+$/)?.[0];
  if (extension === ".tsx") return "tsx";
  if (extension === ".jsx") return "jsx";
  if ([".js", ".mjs", ".cjs"].includes(extension)) return "js";
  return "ts";
}

export function transpileTypeScriptModule(source, filePath) {
  const sourceWithImportMeta = source.replaceAll(
    "import.meta.url",
    JSON.stringify(pathToFileURL(filePath).href),
  );
  try {
    return transformSync(sourceWithImportMeta, {
      format: "cjs",
      jsx: "automatic",
      loader: loaderFor(filePath),
      platform: "node",
      sourcefile: filePath,
      target: "es2022",
    }).code;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to transpile ${filePath}: ${detail}`, { cause: error });
  }
}
