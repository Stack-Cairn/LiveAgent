// Page-wide switches for K-brain's sandboxed UI that the turn pipeline also reads: the
// "HTML previews" chat setting and requests to reveal the right dock's Panels tool. No
// imports, so loading the turn code pulls in nothing else.

let htmlPreviewsPreferred = true;
const htmlPreviewsPreferenceListeners = new Set<() => void>();

/** Mirrors the "HTML previews" chat setting for run options and transcripts (default on). */
export function setKBrainHtmlPreviewsPreferred(enabled: boolean) {
  if (htmlPreviewsPreferred === enabled) return;
  htmlPreviewsPreferred = enabled;
  for (const listener of htmlPreviewsPreferenceListeners) listener();
}

export function isKBrainHtmlPreviewsPreferred() {
  return htmlPreviewsPreferred;
}

export function subscribeKBrainHtmlPreviewsPreferred(listener: () => void): () => void {
  htmlPreviewsPreferenceListeners.add(listener);
  return () => {
    htmlPreviewsPreferenceListeners.delete(listener);
  };
}

const panelsDockListeners = new Set<() => void>();

/** Asks the page to reveal the right dock's "Panels" tool (e.g. "open in side panel"). */
export function requestKBrainPanelsDock() {
  for (const listener of panelsDockListeners) listener();
}

export function subscribeKBrainPanelsDockRequests(listener: () => void): () => void {
  panelsDockListeners.add(listener);
  return () => {
    panelsDockListeners.delete(listener);
  };
}
