import { ImageIcon as ImagePlus, Loader2, Plus, X } from "../../components/IconSet";
import { useLocale } from "../../i18n";
import type { ImageStudioClient } from "../../lib/imaging/types";
import { cn } from "../../lib/shared/utils";
import { AssetImage } from "./AssetImage";
import { formatMessage, message } from "./studioText";

type Input = { assetId: string; role: "source" | "reference" | "mask" };

const roleKey = (role: Input["role"]) =>
  role === "mask"
    ? "imageStudio.input.role.mask"
    : role === "reference"
      ? "imageStudio.input.role.reference"
      : "imageStudio.input.role.source";

// Fanned cards: the first input sits on top, up to two more peek out behind it.
const layers = [
  "z-30 -rotate-6",
  "z-20 rotate-3 translate-x-1.5 -translate-y-0.5",
  "z-10 rotate-12 translate-x-3 -translate-y-1",
];

export function InputImageStack({
  client,
  inputs,
  canAdd,
  disabledReason,
  uploading,
  onAdd,
  onRemove,
  onCancelUpload,
}: {
  client: ImageStudioClient;
  inputs: Input[];
  canAdd: boolean;
  disabledReason?: string;
  onAdd: () => void;
  onRemove: (index: number) => void;
  uploading: boolean;
  onCancelUpload: () => void;
}) {
  const { t } = useLocale();
  // Upload progress overlays the tile instead of adding a row, so the composer
  // never changes height while a file is in flight.
  const progress = uploading && (
    <div
      role="status"
      className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-1 rounded-xl bg-background/80 text-xs backdrop-blur-[2px]"
    >
      <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
      <span className="sr-only">{t("imageStudio.input.uploading")}</span>
      <button
        type="button"
        aria-label={t("imageStudio.input.cancelUpload")}
        onClick={onCancelUpload}
        className="rounded-md px-1.5 py-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
      >
        {t("imageStudio.input.cancel")}
      </button>
    </div>
  );
  if (!inputs.length)
    return (
      <div className="relative shrink-0">
        <button
          type="button"
          aria-label={t("imageStudio.input.upload")}
          title={canAdd ? t("imageStudio.input.uploadHint") : disabledReason}
          disabled={!canAdd}
          onClick={onAdd}
          className={cn(
            "flex h-24 w-20 shrink-0 items-center justify-center rounded-xl border border-dashed border-border bg-muted/20 text-muted-foreground transition-colors sm:w-24",
            "hover:border-foreground/30 hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
            "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border disabled:hover:text-muted-foreground",
          )}
        >
          <ImagePlus className="size-6" strokeWidth={1.5} />
        </button>
        {progress}
      </div>
    );
  return (
    <div className="group relative h-24 w-20 shrink-0 sm:w-24">
      <ul aria-label={t("imageStudio.input.list")} className="relative size-full">
        {inputs.map((input, index) => (
          <li
            key={`${input.assetId}-${input.role}`}
            className={
              index < layers.length
                ? cn(
                    "absolute inset-1 overflow-hidden rounded-xl border-2 border-background bg-muted shadow-md",
                    layers[index],
                  )
                : "sr-only"
            }
          >
            {index < layers.length && (
              <AssetImage
                client={client}
                assetId={input.assetId}
                alt={formatMessage(message("imageStudio.input.alt", { index: index + 1 }), t)}
                className="size-full object-cover"
              />
            )}
            <span className="sr-only">{t(roleKey(input.role))}</span>
          </li>
        ))}
      </ul>
      <button
        type="button"
        aria-label={t("imageStudio.input.removeFirst")}
        title={formatMessage(
          message("imageStudio.input.remove", { role: t(roleKey(inputs[0].role)) }),
          t,
        )}
        onClick={() => onRemove(0)}
        className={cn(
          "absolute -left-1.5 -top-1.5 z-40 flex size-6 items-center justify-center rounded-full bg-destructive text-white shadow-md transition-opacity",
          "focus-visible:opacity-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
          "lg:opacity-0 lg:group-hover:opacity-100",
        )}
      >
        <X className="size-3.5" />
      </button>
      {inputs.length > 1 && (
        <span className="absolute bottom-0 left-0 z-40 rounded-full bg-black/65 px-1.5 text-xs leading-5 text-white tabular-nums">
          +{inputs.length - 1}
        </span>
      )}
      {progress}
      {canAdd && (
        <button
          type="button"
          aria-label={t("imageStudio.input.addMore")}
          title={t("imageStudio.input.addMore")}
          onClick={onAdd}
          className={cn(
            "absolute -bottom-2 -right-2 z-40 flex size-8 items-center justify-center rounded-full border border-border bg-background text-foreground shadow-md transition-colors",
            "hover:bg-muted focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
          )}
        >
          <Plus className="size-4" />
        </button>
      )}
    </div>
  );
}
