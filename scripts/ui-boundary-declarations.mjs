import {
  parseTypeScriptSource,
  staticStringValue,
  walkSyntaxTree,
} from "./typescript-source-tools.mjs";

function staticPropertyName(name, computed = false) {
  if (!computed && name?.type === "Identifier") return name.name;
  return staticStringValue(name) ?? null;
}

function assignmentTargetName(node) {
  if (node?.type === "Identifier") return node.name;
  if (node?.type !== "MemberExpression" && node?.type !== "OptionalMemberExpression") {
    return null;
  }
  return staticPropertyName(node.property, node.computed);
}

function isFunctionImplementation(node) {
  return node?.type === "ArrowFunctionExpression" || node?.type === "FunctionExpression";
}

export function findRetiredSharedDeclarations(source, fileName, retiredNames) {
  const retired = retiredNames instanceof Set ? retiredNames : new Set(retiredNames);
  const syntaxTree = parseTypeScriptSource(source, fileName);
  const declarations = [];

  function add(name, node, kind) {
    if (!name || !retired.has(name)) return;
    declarations.push({
      name,
      kind,
      line: node.loc?.start.line ?? 1,
      column: (node.loc?.start.column ?? 0) + 1,
    });
  }

  walkSyntaxTree(syntaxTree, (node) => {
    if (node.type === "FunctionDeclaration") {
      add(node.id?.name, node, "function");
    } else if (node.type === "VariableDeclarator" && node.id.type === "Identifier") {
      add(node.id.name, node, "variable");
    } else if (node.type === "ObjectMethod" || node.type === "ClassMethod") {
      add(staticPropertyName(node.key, node.computed), node, "method");
    } else if (
      node.type === "ClassProperty" ||
      node.type === "ClassAccessorProperty" ||
      node.type === "ClassPrivateProperty"
    ) {
      add(staticPropertyName(node.key, node.computed), node, "property");
    } else if (node.type === "ObjectProperty" && isFunctionImplementation(node.value)) {
      add(staticPropertyName(node.key, node.computed), node, "property");
    } else if (node.type === "AssignmentExpression") {
      add(assignmentTargetName(node.left), node, "assignment");
    }
  });

  return declarations;
}

export function rendersImportedComponent(
  source,
  fileName,
  moduleSpecifier,
  importedComponentName,
) {
  const syntaxTree = parseTypeScriptSource(source, fileName);
  const localComponentNames = new Set();

  for (const statement of syntaxTree.program.body) {
    if (
      statement.type !== "ImportDeclaration" ||
      statement.source.value !== moduleSpecifier ||
      statement.importKind === "type"
    ) {
      continue;
    }
    for (const specifier of statement.specifiers) {
      if (specifier.type !== "ImportSpecifier" || specifier.importKind === "type") continue;
      const importedName =
        specifier.imported.type === "Identifier"
          ? specifier.imported.name
          : specifier.imported.value;
      if (importedName === importedComponentName) {
        localComponentNames.add(specifier.local.name);
      }
    }
  }

  if (localComponentNames.size === 0) return false;
  let rendersComponent = false;
  walkSyntaxTree(syntaxTree, (node) => {
    if (
      node.type === "JSXOpeningElement" &&
      node.name.type === "JSXIdentifier" &&
      localComponentNames.has(node.name.name)
    ) {
      rendersComponent = true;
    }
  });
  return rendersComponent;
}
