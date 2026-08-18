import { Empty, Field } from "../shared";
import type { DetailTabProps } from "../types";

export function OptionsTab({ record, t }: DetailTabProps) {
  const entries: [string, string | undefined][] = [
    [t("trajectory.metric.provider"), record.provider],
    [t("trajectory.metric.model"), record.model],
    ["API", record.api],
    [t("trajectory.metric.stopReason"), record.stopReason],
    ["headerId", record.headerId],
    ["callId", record.callId],
    ["tool", record.toolName],
    ["subagentRunId", record.subagentRunId],
    ["messageIndex", record.messageIndex === undefined ? undefined : String(record.messageIndex)],
  ];
  const visible = entries.filter((entry): entry is [string, string] => entry[1] !== undefined);
  if (visible.length === 0 && (record.retries?.length ?? 0) === 0) return <Empty t={t} />;
  return (
    <div>
      {visible.map(([label, value]) => (
        <Field key={label} label={label} value={value} />
      ))}
      {record.retries?.map((retry) => (
        <Field
          key={`${retry.at}:${retry.attempt}`}
          label={`${t("trajectory.metric.retries")} ${retry.attempt}`}
          value={[retry.error, retry.delayMs === undefined ? undefined : `${retry.delayMs} ms`]
            .filter(Boolean)
            .join(" · ")}
        />
      ))}
    </div>
  );
}
