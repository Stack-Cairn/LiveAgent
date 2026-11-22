// Kept apart from the bundle builder so the palette, settings and app shell can
// open the export dialog without pulling the builder and redaction code into
// the startup bundle.
type ExportListener = () => void;
const exportListeners = new Set<ExportListener>();

/** Opens the mounted diagnostics export dialog (Settings > About, command palette). */
export function requestDiagnosticsExport(): void {
  for (const listener of [...exportListeners]) listener();
}

export function subscribeDiagnosticsExportRequests(listener: ExportListener): () => void {
  exportListeners.add(listener);
  return () => {
    exportListeners.delete(listener);
  };
}
