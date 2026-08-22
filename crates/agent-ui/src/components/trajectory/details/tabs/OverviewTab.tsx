import {
  formatTrajectoryClock,
  formatTrajectoryCount,
  formatTrajectorySeconds,
  trajectoryStatusLabelKey,
} from "../../../../lib/trajectory/presentation";
import { Field } from "../shared";
import type { DetailTabProps } from "../types";

export function OverviewTab({ record, locale, t }: DetailTabProps) {
  return (
    <div>
      <Field
        label={t("trajectory.metric.status")}
        value={t(trajectoryStatusLabelKey(record.status))}
      />
      <Field
        label={t("trajectory.metric.startedAt")}
        value={formatTrajectoryClock(record.startedAt, locale)}
      />
      <Field
        label={t("trajectory.metric.total")}
        value={formatTrajectorySeconds(record.timeSeconds, locale)}
      />
      {record.turn !== null && <Field label="turn" value={String(record.turn)} />}
      {record.step !== null && <Field label="step" value={String(record.step)} />}
      {record.provider !== undefined && (
        <Field label={t("trajectory.metric.provider")} value={record.provider} />
      )}
      {record.model !== undefined && (
        <Field label={t("trajectory.metric.model")} value={record.model} />
      )}
      {record.stopReason !== undefined && (
        <Field label={t("trajectory.metric.stopReason")} value={record.stopReason} />
      )}
      {record.retries !== undefined && record.retries.length > 0 && (
        <Field label={t("trajectory.metric.retries")} value={String(record.retries.length)} />
      )}
      {record.failovers !== undefined && record.failovers.length > 0 && (
        <Field label={t("trajectory.metric.failovers")} value={String(record.failovers.length)} />
      )}
      {record.tokensBefore !== undefined && (
        <Field
          label={t("trajectory.compaction.title")}
          value={t("trajectory.compaction.tokens")
            .replace("{before}", formatTrajectoryCount(record.tokensBefore, locale))
            .replace("{after}", formatTrajectoryCount(record.tokensAfter, locale))}
        />
      )}
      {record.error !== undefined && (
        <Field label={t("trajectory.metric.error")} value={record.error} />
      )}
    </div>
  );
}
