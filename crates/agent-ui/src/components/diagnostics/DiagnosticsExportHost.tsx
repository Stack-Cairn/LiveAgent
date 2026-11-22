import type { AppSettings } from "@liveagent/app/lib/settings";
import { subscribeDiagnosticsExportRequests } from "@liveagent/ui/lib/diagnostics/exportRequests";
import { lazy, Suspense, useEffect, useState } from "react";

// The dialog, bundle builder and redaction rules load on first use only.
const DiagnosticsExportDialog = lazy(async () => ({
  default: (await import("./DiagnosticsExportDialog")).DiagnosticsExportDialog,
}));

/** Mounted once per host; opens the dialog on `requestDiagnosticsExport()`. */
export function DiagnosticsExportHost(props: { settings: AppSettings }) {
  const [open, setOpen] = useState(false);
  useEffect(() => subscribeDiagnosticsExportRequests(() => setOpen(true)), []);
  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <DiagnosticsExportDialog open={open} onOpenChange={setOpen} settings={props.settings} />
    </Suspense>
  );
}
