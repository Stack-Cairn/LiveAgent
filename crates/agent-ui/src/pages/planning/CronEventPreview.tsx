import {
  CalendarDays,
  ExternalLink,
  History,
  Lock,
  Terminal,
  Timer,
  X,
} from "../../components/IconSet";
import { Button } from "../../components/ui/button";
import { Popover, PopoverContent, PopoverTitle } from "../../components/ui/popover";
import type {
  CronOccurrencesResponse,
  CronRunSummary,
  CronTaskType,
} from "../../lib/automation/types";
import { describeCron } from "../../lib/planning/cronDescribe";
import { parseCronEventId, runFailed } from "../../lib/planning/cronLayer";
import { planningDateLocale } from "../../lib/planning/i18n";
import { durationLabel, MINUTE } from "../../lib/planning/time";
import type { PlanningEvent } from "../../lib/planning/types";
import { useCalendarPreferences } from "./calendarDisplay";
import { usePlanningT } from "./usePlanningT";

const KIND_LABEL: Record<CronTaskType, string> = {
  bash: "settings.cronTypeBash",
  http: "settings.cronTypeHttp",
  prompt: "settings.cronTypePrompt",
};

function runStatusKey(run: CronRunSummary) {
  if (run.state === "pending" || run.state === "leased") return "planner.cron.running";
  if (run.state === "expired") return "planner.cron.expired";
  return runFailed(run) ? "planner.cron.failed" : "planner.cron.success";
}

/** Read-only details for a virtual scheduled-task event (planned fire, run or day summary). */
export function CronEventPreview({
  event,
  anchor,
  data,
  onClose,
  onOpenCron,
}: {
  event: PlanningEvent;
  anchor: HTMLElement;
  data: CronOccurrencesResponse;
  onClose(): void;
  onOpenCron?: () => void;
}) {
  const { t, locale } = usePlanningT();
  const [{ cronColor }] = useCalendarPreferences();
  const ref = parseCronEventId(event.id);
  const taskId = ref ? (ref.kind === "run" ? undefined : ref.taskId) : undefined;
  const run = ref?.kind === "run" ? data.runs.find((item) => item.id === ref.runId) : undefined;
  const summary =
    ref?.kind === "day"
      ? data.summaries.find((item) => item.taskId === ref.taskId && item.date === ref.date)
      : undefined;
  const task = data.tasks.find((item) => item.id === (run?.taskId ?? taskId));
  const dateTime = (at: number) =>
    new Intl.DateTimeFormat(planningDateLocale(locale), {
      timeZone: data.timeZone,
      month: "short",
      day: "numeric",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(at);
  const duration = (ms: number) =>
    ms < 1000
      ? t("planner.cron.milliseconds", { count: ms })
      : ms < MINUTE
        ? t("planner.cron.seconds", { count: Math.round(ms / 1000) })
        : durationLabel(ms / MINUTE);
  const runLine = (item: CronRunSummary) =>
    [
      dateTime(item.startedAt),
      t(runStatusKey(item)),
      item.state === "done" || item.state === "expired"
        ? t("planner.cron.duration", { duration: duration(item.durationMs) })
        : "",
      item.exitCode != null ? t("planner.cron.exitCode", { code: item.exitCode }) : "",
    ]
      .filter(Boolean)
      .join(" · ");
  const title = task?.name ?? event.title;
  const description = task ? describeCron(task.cron, locale) : "";

  return (
    <Popover
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <PopoverContent
        anchor={anchor}
        finalFocus={() => (anchor.isConnected ? anchor : false)}
        side="left"
        align="start"
        sideOffset={12}
        className="w-[28rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-3xl bg-popover p-0 shadow-xl"
        aria-label={t("planner.cron.label")}
      >
        <div className="flex items-center justify-end gap-1 px-3 pt-3">
          <Button
            variant="ghost"
            size="icon"
            className="rounded-full"
            aria-label={t("planner.preview.close")}
            onClick={onClose}
          >
            <X className="size-5" />
          </Button>
        </div>
        <div className="max-h-[60dvh] space-y-4 overflow-y-auto px-4 pb-5 pt-1">
          <div className="flex gap-4">
            <span
              className="mx-1 mt-2.5 size-3.5 shrink-0 rounded"
              style={{ backgroundColor: cronColor }}
            />
            <div className="min-w-0">
              <PopoverTitle className="break-words text-2xl font-normal leading-8">
                {title}
              </PopoverTitle>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {[
                  t("planner.cron.layer"),
                  task ? t(KIND_LABEL[task.kind] ?? "planner.cron.layer") : "",
                  task?.remainingExecutions != null
                    ? t("planner.cron.remaining", { count: task.remainingExecutions })
                    : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </div>
          </div>
          <dl className="space-y-3 text-sm [&>div]:gap-4 [&_dt]:px-1">
            {task && (
              <div className="flex items-start gap-3">
                <dt>
                  <Timer
                    className="mt-0.5 size-4 text-muted-foreground"
                    aria-label={t("planner.cron.expression")}
                  />
                </dt>
                <dd className="min-w-0 space-y-0.5">
                  <code className="break-all font-mono text-xs">{task.cron}</code>
                  {description && description !== task.cron && <p>{description}</p>}
                </dd>
              </div>
            )}
            {ref?.kind === "occurrence" && (
              <div className="flex items-center gap-3">
                <dt>
                  <CalendarDays
                    className="size-4 text-muted-foreground"
                    aria-label={t("planner.cron.plannedAt")}
                  />
                </dt>
                <dd>
                  {t("planner.cron.plannedAt")} · {dateTime(ref.at)}
                </dd>
              </div>
            )}
            {run && (
              <div className="flex items-start gap-3">
                <dt>
                  <CalendarDays
                    className="mt-0.5 size-4 text-muted-foreground"
                    aria-label={t("planner.cron.ranAt")}
                  />
                </dt>
                <dd className={runFailed(run) ? "text-destructive" : undefined}>{runLine(run)}</dd>
              </div>
            )}
            {run?.outputPreview && (
              <div className="flex items-start gap-3">
                <dt>
                  <Terminal
                    className="mt-0.5 size-4 text-muted-foreground"
                    aria-label={t("planner.cron.output")}
                  />
                </dt>
                <dd className="min-w-0 flex-1">
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted px-2 py-1.5 font-mono text-xs">
                    {run.outputPreview}
                  </pre>
                </dd>
              </div>
            )}
            {summary && (
              <div className="flex items-start gap-3">
                <dt>
                  <CalendarDays
                    className="mt-0.5 size-4 text-muted-foreground"
                    aria-label={t("planner.cron.plannedAt")}
                  />
                </dt>
                <dd className="space-y-0.5">
                  <p>
                    {dateTime(summary.firstAt)} – {dateTime(summary.lastAt)}
                  </p>
                  <p className="text-muted-foreground">
                    {[
                      summary.planned > 0
                        ? t("planner.cron.dayPlanned", {
                            count: `${summary.planned}${summary.plannedTruncated ? "+" : ""}`,
                          })
                        : "",
                      summary.ran > 0 ? t("planner.cron.dayRan", { count: summary.ran }) : "",
                      summary.failed > 0
                        ? t("planner.cron.dayFailed", { count: summary.failed })
                        : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </dd>
              </div>
            )}
            {task && (
              <div className="flex items-start gap-3">
                <dt>
                  <History
                    className="mt-0.5 size-4 text-muted-foreground"
                    aria-label={t("planner.cron.lastRun")}
                  />
                </dt>
                <dd>
                  {t("planner.cron.lastRun")} ·{" "}
                  {task.lastRun ? runLine(task.lastRun) : t("planner.cron.noRuns")}
                </dd>
              </div>
            )}
            <div className="flex items-center gap-3 text-muted-foreground">
              <dt>
                <Lock className="size-4" aria-label={t("planner.calendar.readOnly")} />
              </dt>
              <dd>{t("planner.cron.readOnly")}</dd>
            </div>
          </dl>
        </div>
        {onOpenCron && (
          <div className="flex justify-end px-4 pb-4">
            <Button
              variant="secondary"
              className="h-10 gap-2 rounded-full px-6"
              onClick={() => {
                onClose();
                onOpenCron();
              }}
            >
              <ExternalLink className="size-4" />
              {t("planner.cron.open")}
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
