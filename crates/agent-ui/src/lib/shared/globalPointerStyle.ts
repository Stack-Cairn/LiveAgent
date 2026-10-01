export type GlobalPointerStyle = {
  cursor?: string;
  userSelect?: string;
};

type ActiveStyle = GlobalPointerStyle & { token: symbol };

const activeStyles: ActiveStyle[] = [];
let originalStyle: GlobalPointerStyle | null = null;

function removeSafetyListeners() {
  window.removeEventListener("blur", releaseAllGlobalPointerStyles);
  document.removeEventListener("visibilitychange", handleVisibilityChange);
}

function releaseAllGlobalPointerStyles() {
  activeStyles.length = 0;
  if (originalStyle !== null) {
    document.body.style.cursor = originalStyle.cursor ?? "";
    document.body.style.userSelect = originalStyle.userSelect ?? "";
    originalStyle = null;
  }
  removeSafetyListeners();
}

function handleVisibilityChange() {
  if (document.visibilityState !== "visible") releaseAllGlobalPointerStyles();
}

function applyActiveStyles() {
  const body = document.body;
  if (!body || originalStyle === null) return;

  let cursor = originalStyle.cursor ?? "";
  let userSelect = originalStyle.userSelect ?? "";
  for (const style of activeStyles) {
    if (style.cursor !== undefined) cursor = style.cursor;
    if (style.userSelect !== undefined) userSelect = style.userSelect;
  }
  body.style.cursor = cursor;
  body.style.userSelect = userSelect;
}

/**
 * Acquires the document-wide cursor/selection presentation for one pointer
 * interaction. Overlapping sessions compose in acquisition order and releasing
 * an older session cannot restore stale inline styles over a newer one.
 */
export function acquireGlobalPointerStyle(style: GlobalPointerStyle): () => void {
  if (typeof document === "undefined" || !document.body) return () => {};
  if (originalStyle === null) {
    originalStyle = {
      cursor: document.body.style.cursor,
      userSelect: document.body.style.userSelect,
    };
    window.addEventListener("blur", releaseAllGlobalPointerStyles);
    document.addEventListener("visibilitychange", handleVisibilityChange);
  }

  const token = Symbol("global-pointer-style");
  activeStyles.push({ ...style, token });
  applyActiveStyles();

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const index = activeStyles.findIndex((entry) => entry.token === token);
    if (index >= 0) activeStyles.splice(index, 1);
    if (activeStyles.length > 0) {
      applyActiveStyles();
      return;
    }
    releaseAllGlobalPointerStyles();
  };
}
