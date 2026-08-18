import {
  formatTrajectoryClock,
  formatTrajectoryDuration,
  formatTrajectorySeconds,
  trajectoryAssistantSegments,
  trajectoryThroughputTokensPerSecond,
} from "../../../../lib/trajectory/presentation";
import { Empty, Field } from "../shared";
import type { DetailTabProps } from "../types";

export function TimingTab({ record, locale, t }: DetailTabProps) {
  const segments = trajectoryAssistantSegments(record);
  const throughput = trajectoryThroughputTokensPerSecond(record);
  if (segments === null && record.timeSeconds === null && record.startedAt === null) {
    return <Empty t={t} />;
  }
  return (
    <div>
      <Field
        label={t("trajectory.metric.startedAt")}
        value={formatTrajectoryClock(record.startedAt, locale)}
      />
      <Field
        label={t("trajectory.metric.total")}
        value={formatTrajectorySeconds(record.timeSeconds, locale)}
      />
      {segments !== null && (
        <>
          <Field
            label={t("trajectory.metric.ttft")}
            value={formatTrajectoryDuration(segments.ttftMs, locale)}
          />
          <Field
            label={t("trajectory.metric.decoding")}
            value={formatTrajectoryDuration(segments.decodingMs, locale)}
          />
        </>
      )}
      {throughput !== null && (
        <Field label={t("trajectory.metric.throughput")} value={`${throughput.toFixed(1)} tok/s`} />
      )}
    </div>
  );
}
