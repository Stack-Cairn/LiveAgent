// React 19's development build records component and scheduler measures with
// potentially large props diffs in detail.devtools. User Timing retains them
// until explicitly cleared, even after the React trees have been collected.
// Hosts install this only in DEV; production timing and application measures
// are unaffected. Performance recordings still receive the original entries.

function isReactDevMeasure(entry: PerformanceEntry): boolean {
  if (entry.entryType !== "measure") return false;
  const detail = (entry as PerformanceMeasure).detail;
  if (!detail || typeof detail !== "object") return false;
  const devtools = detail.devtools;
  return (
    !!devtools &&
    typeof devtools === "object" &&
    (devtools.track === "Components ⚛" || devtools.trackGroup === "Scheduler ⚛")
  );
}

export function installReactDevTimelineLimit(maxEntries = 2_000): () => void {
  if (
    typeof performance === "undefined" ||
    typeof PerformanceObserver === "undefined" ||
    !PerformanceObserver.supportedEntryTypes.includes("measure")
  ) {
    return () => {};
  }
  let retained = 0;
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (isReactDevMeasure(entry)) retained += 1;
    }
    if (retained <= maxEntries) return;
    const entries = performance.getEntriesByType("measure");
    const reactNames = new Set<string>();
    const applicationNames = new Set<string>();
    for (const entry of entries) {
      if (isReactDevMeasure(entry)) reactNames.add(entry.name);
      else applicationNames.add(entry.name);
    }
    // clearMeasures is name-based. Preserve application entries even if an
    // application happens to use the same name as a React component measure.
    for (const name of reactNames) {
      if (!applicationNames.has(name)) performance.clearMeasures(name);
    }
    retained = performance.getEntriesByType("measure").filter(isReactDevMeasure).length;
  });
  observer.observe({ type: "measure", buffered: true });
  return () => observer.disconnect();
}
