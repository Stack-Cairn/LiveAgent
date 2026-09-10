/** Exact Tailwind shorthand candidates. Prefixes, importance and overlapping axes stay intact. */
export function splitUtility(token) {
  let depth = 0,
    lastColon = -1;
  for (let i = 0; i < token.length; i++) {
    if ("[(".includes(token[i])) depth++;
    if ("])".includes(token[i])) depth--;
    if (token[i] === ":" && depth === 0) lastColon = i;
  }
  const prefix = token.slice(0, lastColon + 1);
  let utility = token.slice(lastColon + 1),
    important = "";
  if (utility.startsWith("!")) {
    important = "!";
    utility = utility.slice(1);
  }
  if (utility.endsWith("!")) {
    important = "!";
    utility = utility.slice(0, -1);
  }
  return { prefix, important, utility };
}
const rules = [
  { axes: ["h", "w"], result: "size", family: /^(?:h|w|size)-/ },
  { axes: ["px", "py"], result: "p", family: /^p(?:[xytrblse])?-/ },
  { axes: ["gap-x", "gap-y"], result: "gap", family: /^gap(?:-[xy])?-/ },
  {
    axes: ["top", "right", "bottom", "left"],
    result: "inset",
    family: /^(?:top|right|bottom|left|start|end|inset(?:-[xyse])?)-/,
  },
  {
    axes: ["inset-x", "inset-y"],
    result: "inset",
    family: /^(?:top|right|bottom|left|start|end|inset(?:-[xyse])?)-/,
  },
  { axes: ["top", "bottom"], result: "inset-y", family: /^(?:top|bottom|inset(?:-y)?)-/ },
  {
    axes: ["left", "right"],
    result: "inset-x",
    family: /^(?:left|right|start|end|inset(?:-[xse])?)-/,
  },
];
export function compactClasses(value) {
  const tokens = value.split(/(\s+)/),
    changes = [];
  for (const rule of rules) {
    const parsed = tokens.map(splitUtility);
    for (let i = 0; i < parsed.length; i++) {
      const first = parsed[i];
      if (!first.utility.startsWith(rule.axes[0] + "-")) continue;
      const suffix = first.utility.slice(rule.axes[0].length + 1);
      if (!suffix || suffix.includes("${")) continue;
      const positions = rule.axes.map((axis) =>
        parsed.findIndex(
          (t) =>
            t.prefix === first.prefix &&
            t.important === first.important &&
            t.utility === axis + "-" + suffix,
        ),
      );
      if (positions.some((p) => p < 0)) continue;
      // A larger shorthand must not change the winner among overlapping declarations.
      const family = parsed.filter((t) => t.prefix === first.prefix && rule.family.test(t.utility));
      if (family.length !== positions.length) continue;
      const result = first.prefix + rule.result + "-" + suffix + first.important;
      const ordered = positions.sort((a, b) => a - b);
      changes.push({ before: ordered.map((p) => tokens[p]).join(" "), after: result });
      tokens[ordered[0]] = result;
      for (const p of ordered.slice(1)) {
        tokens[p] = "";
        if (tokens[p - 1]?.trim() === "") tokens[p - 1] = "";
      }
      break;
    }
  }
  return { value: tokens.join(""), changes };
}
