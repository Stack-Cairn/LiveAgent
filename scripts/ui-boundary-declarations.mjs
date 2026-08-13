import { createRequire } from "node:module";

const requireFromAgentUi = createRequire(
  new URL("../crates/agent-ui/package.json", import.meta.url),
);
const ts = requireFromAgentUi("typescript");

function staticPropertyName(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  if (!ts.isComputedPropertyName(name)) return null;
  return ts.isStringLiteralLike(name.expression) ? name.expression.text : null;
}

function assignmentTargetName(node) {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (!ts.isElementAccessExpression(node)) return null;
  return node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression)
    ? node.argumentExpression.text
    : null;
}

function isFunctionImplementation(node) {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

export function findRetiredSharedDeclarations(source, fileName, retiredNames) {
  const retired = retiredNames instanceof Set ? retiredNames : new Set(retiredNames);
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const declarations = [];

  function add(name, node, kind) {
    if (!name || !retired.has(name)) return;
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    declarations.push({
      name,
      kind,
      line: position.line + 1,
      column: position.character + 1,
    });
  }

  function visit(node) {
    if (ts.isFunctionDeclaration(node)) {
      add(node.name?.text, node, "function");
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      add(node.name.text, node, "variable");
    } else if (
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)
    ) {
      add(staticPropertyName(node.name), node, "method");
    } else if (ts.isPropertyDeclaration(node)) {
      add(staticPropertyName(node.name), node, "property");
    } else if (ts.isPropertyAssignment(node) && isFunctionImplementation(node.initializer)) {
      add(staticPropertyName(node.name), node, "property");
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      add(assignmentTargetName(node.left), node, "assignment");
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return declarations;
}
