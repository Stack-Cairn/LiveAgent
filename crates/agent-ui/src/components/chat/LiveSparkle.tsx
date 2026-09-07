import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";

const SPARKLE_STARS = [
  {
    id: "primary",
    d: "M14.5996 7.1901C14.5995 7.11268 14.578 7.0368 14.5373 6.97092C14.4967 6.90503 14.4386 6.85171 14.3694 6.81691L11.4383 5.34836L9.97291 2.41153C9.83126 2.12845 9.36908 2.12845 9.2277 2.41153L7.76227 5.34836L4.83117 6.81691C4.76164 6.85139 4.70311 6.90461 4.6622 6.97057C4.62129 7.03653 4.59961 7.11261 4.59961 7.19023C4.59961 7.26785 4.62129 7.34393 4.6622 7.40989C4.70311 7.47585 4.76164 7.52907 4.83117 7.56355L7.76227 9.0321L9.2277 11.9689C9.2623 12.0381 9.31549 12.0963 9.3813 12.137C9.44711 12.1777 9.52294 12.1992 9.6003 12.1992C9.67766 12.1992 9.75349 12.1777 9.8193 12.137C9.88511 12.0963 9.9383 12.0381 9.97291 11.9689L11.4383 9.0321L14.3694 7.56407C14.4387 7.52918 14.4969 7.47574 14.5375 7.40971C14.5781 7.34367 14.5996 7.26764 14.5996 7.1901Z",
    fillOpacity: undefined,
    dur: "1.8s",
    values: "1;0;1",
  },
  {
    id: "small",
    d: "M3.09288 3.86686L1.85165 3.3492C1.82397 3.33536 1.80069 3.31408 1.78442 3.28776C1.76815 3.26143 1.75954 3.2311 1.75954 3.20015C1.75954 3.1692 1.76815 3.13887 1.78442 3.11255C1.80069 3.08622 1.82397 3.06494 1.85165 3.0511L3.09288 2.53365L3.61037 1.29251C3.6242 1.26478 3.64548 1.24145 3.67183 1.22514C3.69817 1.20883 3.72855 1.2002 3.75954 1.2002C3.79053 1.2002 3.8209 1.20883 3.84725 1.22514C3.8736 1.24145 3.89488 1.26478 3.9087 1.29251L4.42619 2.53365L5.66743 3.0511C5.6951 3.06494 5.71838 3.08622 5.73465 3.11255C5.75092 3.13887 5.75954 3.1692 5.75954 3.20015C5.75954 3.2311 5.75092 3.26143 5.73465 3.28776C5.71838 3.31408 5.6951 3.33536 5.66743 3.3492L4.42619 3.86686L3.9087 5.108C3.89488 5.13573 3.8736 5.15906 3.84725 5.17537C3.8209 5.19168 3.79053 5.20031 3.75954 5.20031C3.72855 5.20031 3.69817 5.19168 3.67183 5.17537C3.64548 5.15906 3.6242 5.13573 3.61037 5.108L3.09288 3.86686Z",
    fillOpacity: "0.4",
    dur: ".8s",
    values: "0.4;0;0.4",
  },
  {
    id: "medium",
    d: "M2.79996 13.2001L0.938168 12.4236C0.89665 12.4028 0.861734 12.3709 0.837331 12.3314C0.812928 12.292 0.800003 12.2465 0.800003 12.2C0.800003 12.1536 0.812928 12.1081 0.837331 12.0686C0.861734 12.0291 0.89665 11.9972 0.938168 11.9765L2.79996 11.2003L3.57617 9.33866C3.59691 9.29707 3.62883 9.26207 3.66835 9.23761C3.70787 9.21315 3.75343 9.2002 3.79991 9.2002C3.84639 9.2002 3.89195 9.21315 3.93148 9.23761C3.971 9.26207 4.00292 9.29707 4.02365 9.33866L4.79987 11.2003L6.66166 11.9765C6.70318 11.9972 6.73809 12.0291 6.7625 12.0686C6.7869 12.1081 6.79982 12.1536 6.79982 12.2C6.79982 12.2465 6.7869 12.292 6.7625 12.3314C6.73809 12.3709 6.70318 12.4028 6.66166 12.4236L4.79987 13.2001L4.02365 15.0617C4.00292 15.1033 3.971 15.1383 3.93148 15.1628C3.89195 15.1872 3.84639 15.2002 3.79991 15.2002C3.75343 15.2002 3.70787 15.1872 3.66835 15.1628C3.62883 15.1383 3.59691 15.1033 3.57617 15.0617L2.79996 13.2001Z",
    fillOpacity: "0.6",
    dur: "1.2s",
    values: "0.6;0;0.6",
  },
] as const;

/**
 * The turn-level liveness beacon: a softly twinkling sparkle cluster pinned
 * under the live reply for the whole run — through tool gaps, reasoning,
 * compaction and summarizing — so the transcript never looks stalled between
 * activities. It replaces transient "thinking…"-style filler rows: concrete
 * activity renders its own block, the sparkle only says "still alive".
 *
 * The three stars twinkle via SMIL fill-opacity animations at staggered
 * periods, so the cluster shimmers without any CSS keyframes.
 *
 * `paused` drops those animations: when the turn is blocked on a user
 * decision (a question, a plan, a tool approval) nothing is actually
 * running, and a twinkling beacon would misreport the run as busy.
 */
export function LiveSparkle({
  className,
  paused = false,
}: {
  className?: string;
  paused?: boolean;
}) {
  const { t } = useLocale();
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={paused ? t("chat.work.awaitingDecision") : t("chat.work.running")}
      className={cn("flex items-center py-1 text-foreground/80", className)}
      data-live-sparkle=""
      data-paused={paused ? "" : undefined}
    >
      {/* 星标本体 20px，比思考/工具行的 12px 图标列宽：装进一个图标列宽度的
          盒子里居中溢出，星群才和上面那列图标共用同一条竖中轴。 */}
      <span aria-hidden="true" className="flex h-5 w-3 shrink-0 items-center justify-center">
        <svg
          aria-hidden="true"
          className="h-5 w-5 shrink-0"
          fill="currentColor"
          viewBox="0 0 16 16"
          xmlns="http://www.w3.org/2000/svg"
        >
          {SPARKLE_STARS.map((star) => (
            <path key={star.id} d={star.d} fillOpacity={star.fillOpacity}>
              {paused ? null : (
                <animate
                  attributeName="fill-opacity"
                  attributeType="XML"
                  dur={star.dur}
                  keyTimes="0;0.5;1"
                  repeatCount="indefinite"
                  values={star.values}
                />
              )}
            </path>
          ))}
        </svg>
      </span>
    </div>
  );
}
