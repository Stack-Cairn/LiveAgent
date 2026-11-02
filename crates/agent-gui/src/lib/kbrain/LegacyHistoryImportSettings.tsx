import { Button } from "@liveagent/ui/components/ui/button";
import { useLocale } from "@liveagent/ui/i18n";
import { SettingsGroup, SettingsRow } from "@liveagent/ui/pages/settings/shared";
import { useSyncExternalStore } from "react";
import { isTauriHost } from "../host";
import {
  getHistoryMigrationFailures,
  type HistoryMigrationFailureRecord,
  subscribeHistoryMigrationFailures,
} from "./historyMigrationFailures";
import {
  getHistoryImportState,
  importOldConversations,
  subscribeHistoryImport,
} from "./manualHistoryImport";
import { kBrainStorageScope } from "./mapping";

export function formatMigrationBytes(bytes: number | undefined) {
  return bytes === undefined ? "" : `${(bytes / 1048576).toFixed(1)} MB`;
}

export function HistoryMigrationFailureList({
  records,
}: {
  records: readonly HistoryMigrationFailureRecord[];
}) {
  const { t } = useLocale();
  return (
    <ul className="max-h-60 space-y-1.5 overflow-y-auto" data-testid="history-migration-failures">
      {records.map((record) => (
        <li key={record.sourceId} className="break-words">
          <span className="font-medium">{record.title || record.sourceId}</span>
          <span className="text-muted-foreground"> · {record.sourceId.slice(0, 8)}</span>
          {record.bytes !== undefined && (
            <span className="text-muted-foreground"> · {formatMigrationBytes(record.bytes)}</span>
          )}
          <div className="text-muted-foreground text-xs">
            {t(`historyImport.reason.${record.kind}`)}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function LegacyHistoryImportSettings() {
  const { t } = useLocale();
  const state = useSyncExternalStore(subscribeHistoryImport, getHistoryImportState);
  const scope = kBrainStorageScope();
  const recorded = useSyncExternalStore(subscribeHistoryMigrationFailures, () =>
    getHistoryMigrationFailures(scope),
  );
  const desktop = isTauriHost();
  const result = state.result;
  const imported = result?.results.filter((item) => item.status === "imported").length ?? 0;
  const existing = result?.results.filter((item) => item.status === "already_imported").length ?? 0;
  const incomplete =
    result?.results.filter(
      (item) => item.checkpoint === "partial" || item.checkpoint === "unresolved",
    ).length ?? 0;
  const summary = t("historyImport.result")
    .replace("{imported}", String(imported))
    .replace("{existing}", String(existing))
    .replace("{failed}", String(result?.failures.length ?? 0));
  return (
    <SettingsGroup title={t("historyImport.title")}>
      <SettingsRow
        title={t("historyImport.action")}
        description={t(desktop ? "historyImport.description" : "historyImport.desktopOnly")}
        control={
          <Button
            data-testid="import-legacy-history"
            disabled={!desktop || state.running}
            onClick={() => void importOldConversations()}
          >
            {t(state.running ? "historyImport.running" : "historyImport.action")}
          </Button>
        }
      />
      <div
        role="status"
        aria-live="polite"
        className="space-y-2 break-words text-sm"
        data-testid="legacy-history-import-result"
      >
        {state.running && <p>{t("historyImport.runningHint")}</p>}
        {result && (
          <>
            <p>{summary}</p>
            {result.results.length === 0 && result.failures.length === 0 && (
              <p>{t("historyImport.empty")}</p>
            )}
            {incomplete > 0 && (
              <p>{t("historyImport.partial").replace("{count}", String(incomplete))}</p>
            )}
            {result.failures
              .filter((failure) => !failure.kind)
              .map((failure) => (
                // Source-level paging errors have no conversation record to list.
                <p key={failure.sourceId}>
                  {failure.sourceId}: {failure.error}
                </p>
              ))}
          </>
        )}
        {recorded.all.length > 0 && (
          <details open={!result}>
            <summary>
              {t("historyImport.failedList").replace("{count}", String(recorded.all.length))}
            </summary>
            <HistoryMigrationFailureList records={recorded.all} />
          </details>
        )}
        {state.error && <p>{state.error}</p>}
      </div>
    </SettingsGroup>
  );
}
