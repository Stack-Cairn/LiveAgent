// Organizer run-history modal. All protocol parsing goes through the typed
// run report in lib/memory/organizer/runRecord — v4 reports round-trip
// unchanged; pre-v4 runs degrade to a read-only legacy view (summaries and
// review notes only: no decisions, no manual apply).
//
// Shared implementation owned by @liveagent/ui.

import { AlertTriangle, BrushCleaning, Check, RefreshCw } from "@liveagent/ui/components/IconSet";
import {
  AlertDialog,
  AlertDialogActions,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@liveagent/ui/components/ui/alert-dialog";
import { Button } from "@liveagent/ui/components/ui/button";
import { Checkbox } from "@liveagent/ui/components/ui/checkbox";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@liveagent/ui/components/ui/dialog";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { useEffect, useState } from "react";
import {
  formatMemoryError,
  type MemoryOrganizeRunStatus,
  memoryApplyBatch,
  memoryOrganizeRunClearHistory,
  memoryOrganizeRunUpdate,
} from "../../../lib/memory/api";
import {
  appliedBatchCount,
  buildManualApplyState,
  buildReviewItemsForBatch,
  decisionsWithApplyStatus,
  failedDecisionKeysFromReviewItems,
  isDefaultSelectedDecision,
  ORGANIZE_RUN_REPORT_VERSION,
  type OrganizeRunReportV4,
  organizerDecisionKey,
  readRunReport,
  successfulDecisionKeys,
} from "../../../lib/memory/organizer/runRecord";
import { DrawerSelect } from "./DrawerSelect";
import {
  deriveManualApplyDisplay,
  displayedFinalSummary,
  EMPTY_MANUAL_APPLY_STATE,
  formatTime,
  manualApplySummaryText,
  modelNameFromRun,
  organizerApplyStatusClass,
  organizerApplyStatusLabel,
  organizerReviewItemClass,
  organizerReviewItemLabel,
  organizerRiskClass,
  organizerRiskLabel,
  organizerStatusClass,
  organizerStatusLabel,
  organizerTriggerLabel,
  rejectionBucketEntries,
} from "./panelModel";
import { useOrganizeRunHistory } from "./useMemoryPanelData";

export function OrganizerHistoryModal(props: {
  t: (key: string) => string;
  onClose: () => void;
  workdir?: string;
  onMemoryChanged?: () => void;
}) {
  const { t, onClose, workdir, onMemoryChanged } = props;
  const [statusFilter, setStatusFilter] = useState<"all" | MemoryOrganizeRunStatus>("all");
  const { runs, selectedRun, setSelectedRun, loading, error, setError, reload } =
    useOrganizeRunHistory({ statusFilter });
  const [applyingPreview, setApplyingPreview] = useState(false);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [clearingHistory, setClearingHistory] = useState(false);
  const [selectedDecisionKeys, setSelectedDecisionKeys] = useState<Set<string>>(() => new Set());
  const [historyFeedback, setHistoryFeedback] = useState<string | null>(null);

  const report = readRunReport(selectedRun);
  const v4Report = report.version === "legacy" ? null : report;
  const clusterSummaries = report.clusterSummaries;
  const reviewItems = report.reviewItems;
  const rawBlocks = v4Report?.raw ?? [];
  const manualApplyState = v4Report?.manualApplyState ?? EMPTY_MANUAL_APPLY_STATE;
  const parsedSafeDecisions = v4Report?.safeDecisions ?? [];
  const safeDecisions = decisionsWithApplyStatus(
    parsedSafeDecisions,
    manualApplyState,
    reviewItems,
  );
  const rejectionBuckets = rejectionBucketEntries(v4Report?.rejectionBuckets);
  const manualApplyDisplay = deriveManualApplyDisplay({
    run: selectedRun,
    safeDecisions,
    reviewItems,
    manualApplyState,
  });
  const canApplyManualPreview =
    selectedRun?.trigger === "manual" &&
    selectedRun.status === "succeeded" &&
    manualApplyDisplay.status === "pending" &&
    safeDecisions.length > 0;

  // biome-ignore lint/correctness/useExhaustiveDependencies: reseed only when the run or its decision set changes
  useEffect(() => {
    if (!canApplyManualPreview) {
      setSelectedDecisionKeys(new Set());
      return;
    }
    setSelectedDecisionKeys(
      new Set(
        safeDecisions
          .map((decision, index) => ({
            decision,
            key: organizerDecisionKey(decision, index),
          }))
          .filter(({ decision }) => isDefaultSelectedDecision(decision))
          .map(({ key }) => key),
      ),
    );
  }, [selectedRun?.runId, canApplyManualPreview, safeDecisions.length]);

  function togglePreviewDecision(key: string) {
    setSelectedDecisionKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  async function applyManualPreview() {
    if (!selectedRun || !v4Report) return;
    const selectedWithKeys = parsedSafeDecisions
      .map((decision, index) => ({
        decision,
        key: organizerDecisionKey(decision, index),
      }))
      .filter((item) => selectedDecisionKeys.has(item.key));
    if (selectedWithKeys.length === 0) {
      setError(t("settings.memoryOrganizerSelectAtLeastOne"));
      return;
    }
    setApplyingPreview(true);
    setError(null);
    try {
      const batch = await memoryApplyBatch({
        workdir,
        trigger: "memory-organize",
        model: modelNameFromRun(selectedRun),
        decisions: selectedWithKeys.map((item) => item.decision),
      });
      const appliedCount = appliedBatchCount(batch);
      const nextReviewItems = buildReviewItemsForBatch(batch, selectedWithKeys);
      const appliedDecisionKeys = successfulDecisionKeys(selectedWithKeys, batch);
      const failedDecisionKeys = failedDecisionKeysFromReviewItems(
        selectedWithKeys,
        nextReviewItems,
      );
      const manualApplyStateForReport = buildManualApplyState({
        selectedCount: selectedWithKeys.length,
        appliedCount,
        warningCount: nextReviewItems.length,
        appliedDecisionKeys,
        failedDecisionKeys,
      });
      const appliedKeySet = new Set(appliedDecisionKeys);
      const failedKeySet = new Set(failedDecisionKeys);
      const safeDecisionsForReport = parsedSafeDecisions.map((decision, index) => {
        const key = organizerDecisionKey(decision, index);
        if (failedKeySet.has(key)) return { ...decision, applyStatus: "failed" as const };
        if (appliedKeySet.has(key)) return { ...decision, applyStatus: "applied" as const };
        return decision;
      });
      const manualSummary = manualApplySummaryText({
        selectedCount: selectedWithKeys.length,
        appliedCount,
        warningCount: nextReviewItems.length,
      });
      const existingFinalSummary = selectedRun.finalSummary?.trim() || "";
      const nextReport: OrganizeRunReportV4 = {
        ...v4Report,
        version: ORGANIZE_RUN_REPORT_VERSION,
        reviewItems: [...reviewItems, ...nextReviewItems],
        safeDecisions: safeDecisionsForReport,
        manualApplyState: manualApplyStateForReport,
      };
      await memoryOrganizeRunUpdate({
        runId: selectedRun.runId,
        safeApplied: appliedCount,
        createdCount: batch.created.length,
        updatedCount: batch.updated.length,
        deletedCount: batch.deleted.length,
        reviewSkipped: selectedRun.reviewSkipped + nextReviewItems.length,
        finalSummary: existingFinalSummary.includes("手动应用结果")
          ? manualSummary
          : `${manualSummary}${existingFinalSummary ? `\n\n模型原始总结：${existingFinalSummary}` : ""}`,
        report: nextReport,
      });
      await reload(selectedRun.runId);
      onMemoryChanged?.();
    } catch (err) {
      setError(formatMemoryError(err));
    } finally {
      setApplyingPreview(false);
    }
  }

  async function clearHistory() {
    setClearingHistory(true);
    setError(null);
    setHistoryFeedback(null);
    try {
      const response = await memoryOrganizeRunClearHistory();
      setClearConfirmOpen(false);
      setSelectedRun(null);
      setSelectedDecisionKeys(new Set());
      setHistoryFeedback(
        response.retainedActiveCount > 0
          ? t("settings.memoryOrganizerHistoryClearedActiveRetained")
          : t("settings.memoryOrganizerHistoryCleared"),
      );
      await reload(undefined, { keepSelection: false });
    } catch (err) {
      setError(formatMemoryError(err));
    } finally {
      setClearingHistory(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="flex h-[min(760px,calc(100dvh-2rem))] max-w-6xl flex-col p-0"
        closeLabel={t("settings.memorySettingsClose")}
        showCloseButton
      >
        <DialogHeader>
          <DialogTitle className="text-sm">{t("settings.memoryOrganizerHistory")}</DialogTitle>
          <DialogDescription className="text-xs">
            {t("settings.memoryOrganizerHistoryDescription")}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="grid grid-cols-[280px_minmax(0,1fr)] overflow-hidden p-0">
          <aside className="flex min-h-0 flex-col border-r border-border/50">
            <div className="space-y-2 border-b border-border/40 p-3">
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <DrawerSelect
                    value={statusFilter}
                    onValueChange={(next) =>
                      setStatusFilter(next as "all" | MemoryOrganizeRunStatus)
                    }
                    ariaLabel={t("settings.memoryOrganizerHistoryAll")}
                    options={[
                      {
                        value: "all",
                        label: t("settings.memoryOrganizerHistoryAll"),
                      },
                      {
                        value: "succeeded",
                        label: t("settings.memoryOrganizerStatusSucceeded"),
                      },
                      {
                        value: "failed",
                        label: t("settings.memoryOrganizerStatusFailed"),
                      },
                      {
                        value: "skipped",
                        label: t("settings.memoryOrganizerStatusSkipped"),
                      },
                      {
                        value: "running",
                        label: t("settings.memoryOrganizerStatusRunning"),
                      },
                    ]}
                  />
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="shrink-0 text-muted-foreground hover:text-destructive"
                  title={t("settings.memoryOrganizerClearHistory")}
                  aria-label={t("settings.memoryOrganizerClearHistory")}
                  onClick={() => setClearConfirmOpen(true)}
                  disabled={loading || clearingHistory || runs.length === 0}
                >
                  <BrushCleaning className="h-3.5 w-3.5" />
                </Button>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => reload()}
                disabled={loading}
              >
                <RefreshCw className={cn("h-3.5 w-3.5", loading ? "animate-spin" : "")} />
                {t("settings.memoryRefresh")}
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-2">
              {runs.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border/60 px-3 py-8 text-center text-xs text-muted-foreground">
                  {t("settings.memoryOrganizerHistoryEmpty")}
                </div>
              ) : (
                <div className="space-y-1.5">
                  {runs.map((run) => {
                    const active = selectedRun?.runId === run.runId;
                    return (
                      <Button
                        key={run.runId}
                        variant="outline"
                        aria-pressed={active}
                        onClick={() => reload(run.runId)}
                        className={cn(
                          "h-auto w-full flex-col items-stretch justify-start whitespace-normal rounded-lg px-3 py-2.5 text-left font-normal",
                          active
                            ? "border-primary/50 bg-primary/5"
                            : "border-border/50 bg-background/70 hover:bg-muted/35",
                        )}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span
                            className={cn(
                              "rounded border px-1.5 py-0.5 text-[10px]",
                              organizerStatusClass(run.status),
                            )}
                          >
                            {organizerStatusLabel(run.status, t)}
                          </span>
                          <span className="text-[10px] text-muted-foreground">
                            {organizerTriggerLabel(run.trigger, t)}
                          </span>
                        </div>
                        <div className="mt-1 truncate text-xs font-medium">
                          {run.finalSummary ||
                            run.error ||
                            t("settings.memoryOrganizerHistoryPending")}
                        </div>
                        <div className="mt-1 truncate text-[11px] text-muted-foreground">
                          {formatTime(run.startedAt || run.createdAt)} · {modelNameFromRun(run)}
                        </div>
                      </Button>
                    );
                  })}
                </div>
              )}
            </div>
          </aside>

          <section className="min-h-0 overflow-auto p-5">
            {error ? (
              <div className="mb-4 whitespace-pre-wrap rounded-lg border border-destructive/20 bg-destructive/[0.05] px-3 py-2 text-xs text-destructive">
                {error}
              </div>
            ) : null}
            {historyFeedback ? (
              <div className="mb-4 rounded-lg border border-emerald-500/20 bg-emerald-500/[0.05] px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
                {historyFeedback}
              </div>
            ) : null}
            {selectedRun ? (
              <div className="space-y-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={cn(
                          "rounded border px-2 py-1 text-xs",
                          organizerStatusClass(selectedRun.status),
                        )}
                      >
                        {organizerStatusLabel(selectedRun.status, t)}
                      </span>
                      <span className="rounded border border-border/60 px-2 py-1 text-xs text-muted-foreground">
                        {organizerTriggerLabel(selectedRun.trigger, t)}
                      </span>
                      <span className="rounded border border-border/60 px-2 py-1 text-xs text-muted-foreground">
                        {selectedRun.scope} / {selectedRun.mode}
                      </span>
                    </div>
                    <div className="font-mono text-[11px] text-muted-foreground">
                      {selectedRun.runId}
                    </div>
                  </div>
                  <div className="grid shrink-0 grid-cols-[auto_minmax(9rem,auto)] gap-x-2 gap-y-1 rounded-md border border-border/50 bg-background/70 px-3 py-2 text-xs text-muted-foreground">
                    <span className="whitespace-nowrap">
                      {t("settings.memoryOrganizerStarted")}
                    </span>
                    <span className="whitespace-nowrap text-right font-mono text-foreground/80">
                      {formatTime(selectedRun.startedAt || selectedRun.createdAt)}
                    </span>
                    <span className="whitespace-nowrap">
                      {t("settings.memoryOrganizerFinished")}
                    </span>
                    <span className="whitespace-nowrap text-right font-mono text-foreground/80">
                      {selectedRun.finishedAt ? formatTime(selectedRun.finishedAt) : "-"}
                    </span>
                  </div>
                </div>

                <div className="rounded-lg border border-border/60 bg-muted/15 p-4">
                  <div className="mb-2 text-xs font-semibold text-muted-foreground">
                    {t("settings.memoryOrganizerFinalSummary")}
                  </div>
                  <div className="whitespace-pre-wrap text-sm leading-relaxed">
                    {displayedFinalSummary(selectedRun, manualApplyDisplay) ||
                      t("settings.memoryOrganizerHistoryPending")}
                  </div>
                </div>

                <div className="grid gap-2 sm:grid-cols-4">
                  {[
                    ["settings.memoryOrganizerInputCount", selectedRun.inputCount],
                    ["settings.memoryOrganizerClusterCount", selectedRun.clusterCount],
                    ["settings.memoryOrganizerSafeApplied", selectedRun.safeApplied],
                    ["settings.memoryOrganizerReviewSkipped", selectedRun.reviewSkipped],
                    ["settings.memoryOrganizerCreatedCount", selectedRun.createdCount],
                    ["settings.memoryOrganizerUpdatedCount", selectedRun.updatedCount],
                    ["settings.memoryOrganizerDeletedCount", selectedRun.deletedCount],
                    ["settings.memoryOrganizerParseFailures", selectedRun.parseFailures],
                  ].map(([key, value]) => (
                    <div
                      key={key}
                      className="rounded-lg border border-border/50 bg-background/70 p-3"
                    >
                      <div className="text-[11px] text-muted-foreground">{t(String(key))}</div>
                      <div className="mt-1 text-lg font-semibold">{value}</div>
                    </div>
                  ))}
                </div>

                {safeDecisions.length > 0 ? (
                  <div className="rounded-lg border border-border/60 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <div className="text-xs font-semibold text-muted-foreground">
                          {t("settings.memoryOrganizerManualPreview")}
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {manualApplyDisplay.status === "applied"
                            ? t("settings.memoryOrganizerApplied")
                            : manualApplyDisplay.status === "partial"
                              ? t("settings.memoryOrganizerPartiallyApplied")
                              : manualApplyDisplay.status === "failed"
                                ? t("settings.memoryOrganizerApplyFailed")
                                : t("settings.memoryOrganizerManualPreviewDescription")}
                        </div>
                      </div>
                      {canApplyManualPreview ? (
                        <Button
                          type="button"
                          size="sm"
                          onClick={applyManualPreview}
                          disabled={applyingPreview}
                        >
                          <Check className="h-3.5 w-3.5" />
                          {t("settings.memoryOrganizerApplySelected")}
                        </Button>
                      ) : null}
                    </div>
                    <div className="mt-3 space-y-2">
                      {safeDecisions.map((decision, index) => {
                        const key = organizerDecisionKey(decision, index);
                        const checked =
                          manualApplyDisplay.status && manualApplyDisplay.status !== "pending"
                            ? manualApplyDisplay.appliedDecisionKeys.size === 0
                              ? decision.applyStatus !== "failed"
                              : manualApplyDisplay.appliedDecisionKeys.has(key)
                            : selectedDecisionKeys.has(key);
                        return (
                          <div
                            key={key}
                            className="flex gap-3 rounded-md border border-border/50 bg-background/70 p-3 text-xs"
                          >
                            <Checkbox
                              id={`memory-organizer-decision-${index}`}
                              className="mt-0.5"
                              checked={checked}
                              disabled={!canApplyManualPreview || applyingPreview}
                              onCheckedChange={() => togglePreviewDecision(key)}
                            />
                            <label
                              htmlFor={`memory-organizer-decision-${index}`}
                              className="min-w-0 flex-1"
                            >
                              <span className="flex flex-wrap items-center gap-2">
                                <span className="rounded border border-border/60 px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                                  {decision.op === "delete"
                                    ? t("settings.memoryOrganizerDecisionDelete")
                                    : t("settings.memoryOrganizerDecisionUpsert")}
                                </span>
                                <span className="font-mono text-[11px]">{decision.slug}</span>
                                {decision.scope ? (
                                  <span className="text-[11px] text-muted-foreground">
                                    {decision.scope}
                                    {decision.workdirHash ? `:${decision.workdirHash}` : ""}
                                  </span>
                                ) : null}
                                <span
                                  className={cn(
                                    "rounded border px-1.5 py-0.5 text-[10px]",
                                    organizerRiskClass(decision.riskLevel),
                                  )}
                                >
                                  {organizerRiskLabel(decision.riskLevel, t)}
                                </span>
                                {decision.confidence != null ? (
                                  <span className="rounded border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                                    {t("settings.memoryOrganizerConfidence")}{" "}
                                    {decision.confidence.toFixed(2)}
                                  </span>
                                ) : null}
                                {decision.requiresUserAck ? (
                                  <span className="rounded border border-amber-500/30 bg-amber-500/[0.06] px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-300">
                                    {t("settings.memoryOrganizerRequiresAck")}
                                  </span>
                                ) : null}
                                {decision.applyStatus ? (
                                  <span
                                    className={cn(
                                      "rounded border px-1.5 py-0.5 text-[10px]",
                                      organizerApplyStatusClass(decision.applyStatus),
                                    )}
                                  >
                                    {organizerApplyStatusLabel(decision.applyStatus, t)}
                                  </span>
                                ) : null}
                              </span>
                              <span className="mt-1 block break-words text-muted-foreground">
                                {decision.reason || decision.description || "-"}
                              </span>
                              {decision.applyError?.message ? (
                                <span className="mt-1 block break-words text-destructive">
                                  {decision.applyError.message}
                                </span>
                              ) : null}
                              {decision.sourceSlugs?.length ? (
                                <span className="mt-1 block break-words font-mono text-[10px] text-muted-foreground">
                                  {t("settings.memoryOrganizerSources")}{" "}
                                  {decision.sourceSlugs.join(", ")}
                                </span>
                              ) : null}
                            </label>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : null}

                {rejectionBuckets.length > 0 ? (
                  <div className="rounded-lg border border-border/60 p-4">
                    <div className="mb-3 text-xs font-semibold text-muted-foreground">
                      {t("settings.memoryOrganizerRejectionBuckets")}
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      {rejectionBuckets.map(([key, count]) => (
                        <div
                          key={key}
                          className="rounded-md border border-border/50 bg-background/70 px-3 py-2"
                        >
                          <div className="text-[11px] text-muted-foreground">{t(key)}</div>
                          <div className="mt-1 text-sm font-semibold">{count}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                {reviewItems.length > 0 ? (
                  <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.04] p-4">
                    <div className="mb-2 text-xs font-semibold text-amber-700 dark:text-amber-300">
                      {t("settings.memoryOrganizerReviewNotes")}
                    </div>
                    <ul className="space-y-2 text-xs text-muted-foreground">
                      {reviewItems.map((item, index) => (
                        <li
                          key={`${index}:${item.phase}:${item.slug || ""}:${item.message}`}
                          className="rounded-md border border-border/50 bg-background/70 px-3 py-2"
                        >
                          <div className="mb-1 flex flex-wrap items-center gap-2">
                            <span
                              className={cn(
                                "rounded border px-1.5 py-0.5 text-[10px]",
                                organizerReviewItemClass(item),
                              )}
                            >
                              {organizerReviewItemLabel(item, t)}
                            </span>
                            {item.code ? (
                              <span className="font-mono text-[10px] text-muted-foreground">
                                {item.code}
                              </span>
                            ) : null}
                            {item.slug ? (
                              <span className="font-mono text-[10px] text-muted-foreground">
                                {item.slug}
                              </span>
                            ) : null}
                          </div>
                          <div className="break-words">{item.message}</div>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {clusterSummaries.length > 0 ? (
                  <div className="rounded-lg border border-border/60 p-4">
                    <div className="mb-2 text-xs font-semibold text-muted-foreground">
                      {t("settings.memoryOrganizerClusterSummaries")}
                    </div>
                    <div className="space-y-2">
                      {clusterSummaries.map((summary, index) => (
                        <div
                          key={`${index}:${summary}`}
                          className="rounded bg-muted/30 px-3 py-2 text-xs"
                        >
                          {summary}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                {rawBlocks.length > 0 ? (
                  <details className="rounded-lg border border-border/60 p-4">
                    <summary className="cursor-pointer text-xs font-semibold text-muted-foreground">
                      {t("settings.memoryOrganizerTrimmedProtocol")}
                    </summary>
                    <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/30 p-3 text-[11px]">
                      {JSON.stringify(rawBlocks, null, 2)}
                    </pre>
                  </details>
                ) : null}
              </div>
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                {t("settings.memoryOrganizerHistoryEmpty")}
              </div>
            )}
          </section>
        </DialogBody>
      </DialogContent>
      {clearConfirmOpen ? (
        <AlertDialog open onOpenChange={setClearConfirmOpen}>
          <AlertDialogContent className="max-w-md p-0">
            <AlertDialogHeader className="flex-row items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-destructive/10">
                <AlertTriangle className="h-4 w-4 text-destructive" />
              </div>
              <div className="min-w-0 flex-1">
                <AlertDialogTitle className="text-sm">
                  {t("settings.memoryOrganizerClearHistoryConfirmTitle")}
                </AlertDialogTitle>
                <AlertDialogDescription className="mt-1 text-xs leading-relaxed">
                  {t("settings.memoryOrganizerClearHistoryConfirmDescription")}
                </AlertDialogDescription>
              </div>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogActions>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setClearConfirmOpen(false)}
                  disabled={clearingHistory}
                >
                  {t("settings.memoryCancel")}
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={clearHistory}
                  disabled={clearingHistory}
                >
                  <BrushCleaning className="h-3.5 w-3.5" />
                  {t("settings.memoryOrganizerClearHistory")}
                </Button>
              </AlertDialogActions>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </Dialog>
  );
}
