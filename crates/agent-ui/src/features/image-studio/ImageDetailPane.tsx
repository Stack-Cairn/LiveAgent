import { useId, useState } from "react";
import { Button } from "../../components/ui/button";
import { useLocale } from "../../i18n";
import type { ExportDestination } from "../../lib/imaging/types";
import { AssetImage } from "./AssetImage";
import type { ImageStudioController, StudioView } from "./studioController";
import { formatMessage, message, parameterLabel, parameterValueLabel } from "./studioText";
import { selectClass } from "./TargetParameterForm";

export function ImageDetailPane({
  controller,
  view,
  exportDestinations,
  onCompare,
  onEdit,
}: {
  controller: ImageStudioController;
  view: StudioView;
  exportDestinations: readonly ExportDestination[];
  onCompare: (left: string, right: string) => void;
  onEdit: () => void;
}) {
  const id = view.state.selectedAssetId;
  const [destination, setDestination] = useState<ExportDestination | "">("");
  const [other, setOther] = useState("");
  const prefix = useId();
  const { t } = useLocale();
  const job = Object.values(view.state.jobs).find((job) => job.assetIds.includes(id ?? ""));
  if (!id || !job)
    return <div className="p-4 text-sm text-muted-foreground">{t("imageStudio.detail.empty")}</div>;
  const parent = job.request.parentAssetId;
  const allAssets = [
    ...new Set(Object.values(view.state.jobs).flatMap((item) => item.assetIds)),
  ].filter((asset) => asset !== id);
  const comparison = other && allAssets.includes(other) ? other : (parent ?? allAssets[0]);
  const selectedDestination = exportDestinations.includes(destination as ExportDestination)
    ? (destination as ExportDestination)
    : exportDestinations[0];
  const destinationLabels = {
    download: "imageStudio.download",
    local_workspace: "imageStudio.detail.localWorkspace",
    remote_workspace: "imageStudio.detail.remoteWorkspace",
  };
  return (
    <section aria-label={t("imageStudio.detail.label")} className="space-y-4 p-4">
      <h2 className="text-sm font-semibold">{t("imageStudio.detail.title")}</h2>
      <AssetImage
        client={controller.client}
        assetId={id}
        alt={t("imageStudio.detail.selectedAlt")}
        className="max-h-64 w-full rounded-md object-contain"
      />
      <Button
        className="w-full"
        onClick={() => {
          controller.editAsset(id);
          onEdit();
        }}
      >
        {t("imageStudio.continueEditing")}
      </Button>
      <dl className="space-y-2 text-xs">
        <div>
          <dt className="text-muted-foreground">{t("imageStudio.detail.target")}</dt>
          <dd>
            {formatMessage(
              message("imageStudio.detail.targetRevision", {
                name: job.targetSnapshot.name,
                revision: job.targetSnapshot.revision,
              }),
              t,
            )}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t("imageStudio.detail.prompt")}</dt>
          <dd className="whitespace-pre-wrap break-words">{job.request.prompt}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t("imageStudio.detail.parameters")}</dt>
          <dd>
            <ul>
              {Object.entries(job.request.parameters).map(([key, value]) => {
                const spec = job.targetSnapshot.parameters.find(
                  (candidate) => candidate.key === key,
                );
                return (
                  <li key={key}>
                    {formatMessage(
                      message("imageStudio.detail.parameterLine", {
                        label: spec ? parameterLabel(spec, t) : key,
                        value: spec ? parameterValueLabel(spec, value, t) : String(value),
                      }),
                      t,
                    )}
                  </li>
                );
              })}
            </ul>
            {!Object.keys(job.request.parameters).length && t("imageStudio.detail.defaults")}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t("imageStudio.detail.usage")}</dt>
          <dd>
            {job.usage?.amount == null
              ? t("imageStudio.detail.usageUnknown")
              : job.usage.estimated
                ? formatMessage(
                    message("imageStudio.detail.usageEstimated", {
                      amount: job.usage.amount,
                      currency: job.usage.currency,
                    }),
                    t,
                  )
                : `${job.usage.amount} ${job.usage.currency}`}
          </dd>
        </div>
      </dl>
      {parent && (
        <div className="space-y-1 text-xs">
          <p className="text-muted-foreground">{t("imageStudio.detail.parent")}</p>
          <Button size="sm" variant="outline" onClick={() => controller.selectAsset(parent)}>
            {t("imageStudio.detail.viewParent")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onCompare(parent, id)}>
            {t("imageStudio.detail.compareParent")}
          </Button>
        </div>
      )}
      {comparison && (
        <div className="space-y-2">
          <label htmlFor={`${prefix}-compare`} className="text-xs">
            {t("imageStudio.detail.compareWith")}
          </label>
          <select
            id={`${prefix}-compare`}
            className={selectClass}
            value={comparison}
            onChange={(event) => setOther(event.target.value)}
          >
            {[...new Set([...(parent ? [parent] : []), ...allAssets])].map((asset, index) => (
              <option key={asset} value={asset}>
                {asset === parent
                  ? t("imageStudio.detail.parentOption")
                  : formatMessage(message("imageStudio.result", { index: index + 1 }), t)}
              </option>
            ))}
          </select>
          <Button size="sm" variant="outline" onClick={() => onCompare(comparison, id)}>
            {t("imageStudio.detail.compare")}
          </Button>
        </div>
      )}
      {exportDestinations.length ? (
        <div className="space-y-2">
          <label htmlFor={`${prefix}-export`} className="text-xs">
            {t("imageStudio.detail.exportTo")}
          </label>
          <select
            id={`${prefix}-export`}
            className={selectClass}
            value={selectedDestination}
            onChange={(event) => setDestination(event.target.value as ExportDestination)}
          >
            {exportDestinations.map((value) => (
              <option key={value} value={value}>
                {t(destinationLabels[value])}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              if (selectedDestination) void controller.exportAsset(id, selectedDestination);
            }}
          >
            {t("imageStudio.detail.export")}
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{t("imageStudio.detail.noExport")}</p>
      )}
    </section>
  );
}
