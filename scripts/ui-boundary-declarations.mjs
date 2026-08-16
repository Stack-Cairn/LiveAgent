import { createRequire } from "node:module";

const requireFromAgentUi = createRequire(
  new URL("../crates/agent-ui/package.json", import.meta.url),
);
const ts = requireFromAgentUi("typescript");

function parseSourceFile(source, fileName) {
  return ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

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
  const sourceFile = parseSourceFile(source, fileName);
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

export function rendersImportedComponent(
  source,
  fileName,
  moduleSpecifier,
  importedComponentName,
) {
  const sourceFile = parseSourceFile(source, fileName);
  const localComponentNames = new Set();

  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteralLike(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== moduleSpecifier
    ) {
      continue;
    }
    const importClause = statement.importClause;
    if (!importClause || importClause.isTypeOnly || !importClause.namedBindings) continue;
    if (!ts.isNamedImports(importClause.namedBindings)) continue;
    for (const specifier of importClause.namedBindings.elements) {
      const importedName = specifier.propertyName?.text ?? specifier.name.text;
      if (specifier.isTypeOnly || importedName !== importedComponentName) continue;
      localComponentNames.add(specifier.name.text);
    }
  }

  if (localComponentNames.size === 0) return false;
  let rendersComponent = false;
  function visit(node) {
    if (rendersComponent) return;
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      ts.isIdentifier(node.tagName) &&
      localComponentNames.has(node.tagName.text)
    ) {
      rendersComponent = true;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return rendersComponent;
}
