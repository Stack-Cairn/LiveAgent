import postcss from "postcss";

/** Read top-level rules by selector membership, including grouped selectors. */
export function styleRules(source, selector) {
  return postcss.parse(source).nodes.filter(
    (node) => node.type === "rule" && node.selectors.includes(selector),
  );
}

export function styleDeclarations(source, selector) {
  return Object.fromEntries(
    styleRules(source, selector).flatMap((rule) =>
      rule.nodes.filter((node) => node.type === "decl").map((node) => [node.prop, node.value]),
    ),
  );
}
