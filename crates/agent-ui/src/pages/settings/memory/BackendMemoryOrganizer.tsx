import { Button } from "@liveagent/ui/components/ui/button";
import { useEffect, useRef, useState } from "react";
import {
  type BackendMemoryOrganizerRun,
  formatMemoryError,
  memoryOrganizerRequest,
} from "../../../lib/memory/api";

export function BackendMemoryOrganizer(props: { workdir?: string; t: (key: string) => string }) {
  const { workdir, t } = props;
  const [runs, setRuns] = useState<BackendMemoryOrganizerRun[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scope = useRef(0);
  const inFlight = useRef(false);

  useEffect(() => {
    const current = ++scope.current;
    setRuns([]);
    setError(null);
    void memoryOrganizerRequest<{ runs: BackendMemoryOrganizerRun[] | null }>({
      action: "history",
      workdir,
    })
      .then((result) => {
        if (current === scope.current) setRuns(newestFirst(result.runs));
      })
      .catch((err) => {
        if (current === scope.current) setError(formatMemoryError(err));
      });
    return () => {
      scope.current++;
    };
  }, [workdir]);

  async function request(action: "run" | "apply" | "history", runId?: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    const current = ++scope.current;
    setBusy(true);
    setError(null);
    try {
      if (action !== "history") {
        await memoryOrganizerRequest<BackendMemoryOrganizerRun>({ action, runId, workdir });
      }
      const result = await memoryOrganizerRequest<{ runs: BackendMemoryOrganizerRun[] | null }>({
        action: "history",
        workdir,
      });
      if (current === scope.current) setRuns(newestFirst(result.runs));
    } catch (err) {
      if (current === scope.current) setError(formatMemoryError(err));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <section className="space-y-3 py-5">
      <p className="text-sm text-muted-foreground">
        {t("settings.memoryOrganizerBackendDescription")}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy} onClick={() => void request("run")}>
          {t("settings.memoryOrganizerRunNow")}
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void request("history")}>
          {t("settings.memoryRefresh")}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="break-words text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div aria-live="polite" className="space-y-3">
        {runs.map((run) => (
          <div key={run.runId} className="space-y-2 rounded-lg border p-3 text-xs">
            <p className="break-all font-mono">{run.runId}</p>
            <p>
              {run.status} · {run.phase} · {t("settings.memoryOrganizerInputCount")}: {run.scanned}
            </p>
            {(run.pending ?? []).map((item) => (
              <p key={`${item.op}/${item.scope}/${item.slug}`} className="break-words">
                {item.op} · {item.scope} · {item.slug}
                {item.reason ? ` — ${item.reason}` : ""}
              </p>
            ))}
            {[...new Set(run.warnings ?? [])].map((warning) => (
              <p key={warning} className="break-words text-destructive">
                {warning}
              </p>
            ))}
            {run.status === "pending_review" ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void request("apply", run.runId)}
              >
                {t("settings.memoryOrganizerApplyProposal")}
              </Button>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

function newestFirst(runs: BackendMemoryOrganizerRun[] | null) {
  const timestamp = (value: string | number) =>
    typeof value === "number" ? value : Date.parse(value);
  return [...(runs ?? [])].sort((a, b) => timestamp(b.createdAt) - timestamp(a.createdAt));
}
