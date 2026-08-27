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
  if (
    visible.length === 0 &&
    (record.retries?.length ?? 0) === 0 &&
    (record.failovers?.length ?? 0) === 0 &&
    (record.transports?.length ?? 0) === 0
  ) {
    return <Empty t={t} />;
  }
  return (
    <div>
      {visible.map(([label, value]) => (
        <Field key={label} label={label} value={value} />
      ))}
      {record.transports?.map((transport) => (
        <Field
          key={`transport:${transport.at}:${transport.provider ?? ""}`}
          label={t("trajectory.metric.transport")}
          value={[
            transport.provider,
            transport.upstreamOrigin,
            transport.useSystemProxy === undefined
              ? undefined
              : t(
                  transport.useSystemProxy
                    ? "trajectory.transport.systemProxy"
                    : "trajectory.transport.direct",
                ),
            transport.fullUrl === true ? "full URL" : undefined,
            transport.headerNames === undefined || transport.headerNames.length === 0
              ? undefined
              : transport.headerNames.join(", "),
          ]
            .filter(Boolean)
            .join(" · ")}
        />
      ))}
      {record.retries?.map((retry) => (
        <Field
          key={`${retry.at}:${retry.attempt}`}
          label={`${t("trajectory.metric.retries")} ${retry.attempt}`}
          value={[
            retry.provider,
            retry.error,
            retry.delayMs === undefined ? undefined : `${retry.delayMs} ms`,
          ]
            .filter(Boolean)
            .join(" · ")}
        />
      ))}
      {record.failovers?.map((failover) => (
        <Field
          key={`failover:${failover.at}:${failover.attempt}`}
          label={`${t("trajectory.metric.failovers")} ${failover.attempt}`}
          value={[
            failover.fromLabel !== undefined && failover.toLabel !== undefined
              ? `${failover.fromLabel} → ${failover.toLabel}`
              : (failover.toLabel ?? failover.fromLabel),
            failover.error,
          ]
            .filter(Boolean)
            .join(" · ")}
        />
      ))}
    </div>
  );
}
