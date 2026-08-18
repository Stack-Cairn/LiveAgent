import {
  formatTrajectoryCount,
  TRAJECTORY_USAGE_FIELDS,
} from "../../../../lib/trajectory/presentation";
import { Empty, Field } from "../shared";
import type { DetailTabProps } from "../types";

export function UsageTab({ record, locale, t }: DetailTabProps) {
  if (record.usage === undefined && record.cumulativeUsage === undefined) return <Empty t={t} />;
  return (
    <div>
      {TRAJECTORY_USAGE_FIELDS.map((field) => {
        const own = record.usage?.[field];
        const total = record.cumulativeUsage?.[field];
        if (own === undefined && total === undefined) return null;
        return (
          <Field
            key={field}
            label={field}
            value={`${formatTrajectoryCount(own, locale)}${
              total === undefined
                ? ""
                : ` · ${t("trajectory.metric.cumulative")} ${formatTrajectoryCount(total, locale)}`
            }`}
          />
        );
      })}
    </div>
  );
}
