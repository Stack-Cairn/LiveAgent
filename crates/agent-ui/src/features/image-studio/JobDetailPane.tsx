import { useLocale } from "../../i18n";
import type { ImageJob } from "../../lib/imaging/types";
import { splitFramedPrompt } from "./framing";
import { formatJobTime, statusLabel } from "./studioModel";
import { parameterLabel, parameterValueLabel } from "./studioText";

/** Everything the job was sent with, kept beside the preview so the centre stays about the result. */
export function JobDetailPane({ job }: { job: ImageJob }) {
  const { locale, t } = useLocale();
  const { prompt, framing } = splitFramedPrompt(job.request.prompt);
  const size = [framing?.ratio, framing?.tier].filter(Boolean).join(" · ");
  const rows: [string, string][] = [
    [t("imageStudio.jobDetail.model"), job.targetSnapshot.name],
    [t("imageStudio.jobDetail.status"), statusLabel(job.status, t)],
    [t("imageStudio.jobDetail.created"), formatJobTime(job.createdAt, locale)],
    ...(size ? [[t("imageStudio.jobDetail.size"), size] as [string, string]] : []),
    ...job.targetSnapshot.parameters.flatMap((spec): [string, string][] => {
      const value = job.request.parameters[spec.key];
      return value === undefined || value === null || value === ""
        ? []
        : [[parameterLabel(spec, t), parameterValueLabel(spec, value, t)]];
    }),
    [t("imageStudio.jobDetail.jobId"), job.id],
  ];
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4">
      <h2 className="text-sm font-semibold">{t("imageStudio.jobDetail.title")}</h2>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="break-words text-right">{value}</dd>
          </div>
        ))}
      </dl>
      <section className="space-y-1.5 border-t border-border pt-4">
        <h3 className="text-xs font-semibold text-muted-foreground">
          {t("imageStudio.jobDetail.prompt")}
        </h3>
        <p className="whitespace-pre-wrap break-words text-xs leading-5">{prompt}</p>
      </section>
    </div>
  );
}
