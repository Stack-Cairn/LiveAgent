const DSML_TAG_PREFIX = String.raw`(?:\uFF5C{2}|\|{2})\s*DSML\s*(?:\uFF5C{2}|\|{2})`;

const DSML_TOOL_CALL_DISPLAY_PATTERN = new RegExp(
  String.raw`<\s*${DSML_TAG_PREFIX}\s*tool_calls\s*>[\s\S]*?(?:<\/\s*${DSML_TAG_PREFIX}\s*tool_calls\s*>|$)`,
  "gi",
);
const DSML_ORPHAN_CLOSE_TAGS_PATTERN = new RegExp(
  String.raw`^\s*(?:<\/\s*${DSML_TAG_PREFIX}\s*(?:parameter|invoke|tool_calls)\s*>\s*)+$`,
  "i",
);

function hasDsmlToolCallMarkup(text: string) {
  return text.includes("DSML") && text.includes("tool_calls");
}

export function stripDsmlToolCallMarkup(text: string) {
  if (!hasDsmlToolCallMarkup(text)) return text;
  return text.replace(DSML_TOOL_CALL_DISPLAY_PATTERN, "");
}

export function isOnlyDsmlOrphanCloseTags(text: string) {
  return DSML_ORPHAN_CLOSE_TAGS_PATTERN.test(text);
}
