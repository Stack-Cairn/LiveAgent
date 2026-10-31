import { useId, useState } from "react";
import { Button } from "../../components/ui/button";
import { useLocale } from "../../i18n";
import type { ImageStudioClient } from "../../lib/imaging/types";
import { AssetImage } from "./AssetImage";
import { formatMessage, message } from "./studioText";

export function ImageCompareView({
  client,
  left,
  right,
  onClose,
}: {
  client: ImageStudioClient;
  left: string;
  right: string;
  onClose: () => void;
}) {
  const [zoom, setZoom] = useState(100);
  const id = useId();
  const { t } = useLocale();
  return (
    <section
      aria-label={t("imageStudio.compare.label")}
      className="flex min-h-0 flex-1 flex-col gap-3 p-4"
    >
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-medium">{t("imageStudio.compare.title")}</h2>
        <label htmlFor={id} className="text-sm">
          {formatMessage(message("imageStudio.compare.zoom", { zoom }), t)}
        </label>
        <input
          id={id}
          type="range"
          min={50}
          max={200}
          step={10}
          value={zoom}
          onChange={(event) => setZoom(Number(event.target.value))}
        />
        <Button variant="outline" className="ml-auto" onClick={onClose}>
          {t("imageStudio.compare.back")}
        </Button>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-auto sm:grid-cols-2">
        {[
          { id: left, title: t("imageStudio.compare.left") },
          { id: right, title: t("imageStudio.compare.right") },
        ].map((item) => (
          <figure
            key={item.title}
            className="min-w-0 overflow-auto rounded-lg border border-border bg-muted/20 p-3"
          >
            <figcaption className="mb-2 text-sm text-muted-foreground">{item.title}</figcaption>
            <div style={{ width: `${zoom}%` }}>
              <AssetImage
                client={client}
                assetId={item.id}
                original
                alt={item.title}
                className="h-auto w-full object-contain"
              />
            </div>
          </figure>
        ))}
      </div>
    </section>
  );
}
