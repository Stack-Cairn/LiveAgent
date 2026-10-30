import { SHARED_TRANSLATIONS } from "../../i18n/sharedTranslations";
import { IMAGE_ERROR_FALLBACK_MESSAGE } from "../../lib/imaging/errors";
import type { ImageError, ParameterSpec } from "../../lib/imaging/types";

export type Translate = (key: string) => string;

const english: Record<string, string> = SHARED_TRANSLATIONS["en-US"];
const lookup = (t: Translate, key: string) => {
  const text = t(key);
  return text === key ? undefined : text;
};

type LabelledSpec = Pick<ParameterSpec, "key" | "label">;

// K-brain wire labels that differ from the en-US name (Agnes labels imageSize "Size").
// A Map, not an object: parameter keys are user-defined and may be "constructor".
const wireAliases = new Map([["imageSize", ["Size"]]]);

/**
 * K-brain labels built-in parameters with English wire metadata: the bare key or a
 * fixed English name ("Output compression"). Only those are translated; a label the
 * user wrote in settings, or one carrying a hint ("Size (1K, 1.5K, 2K or width x
 * height)"), names something else under the same key and stays verbatim.
 */
function isWireLabel(spec: LabelledSpec): boolean {
  const names = [
    spec.key,
    english[`imageStudio.parameter.${spec.key}`],
    ...(wireAliases.get(spec.key) ?? []),
  ];
  const label = spec.label.trim().toLowerCase();
  return names.some((name) => name?.toLowerCase() === label);
}

export function parameterLabel(spec: LabelledSpec, t: Translate): string {
  return (isWireLabel(spec) && lookup(t, `imageStudio.parameter.${spec.key}`)) || spec.label;
}

/** Enum values are provider wire values; unknown ones stay as sent. */
export function parameterValueLabel(spec: LabelledSpec, value: unknown, t: Translate): string {
  if (!isWireLabel(spec)) return String(value);
  return lookup(t, `imageStudio.parameter.${spec.key}.${String(value)}`) ?? String(value);
}

/** Image errors carry a client-side English message per code; show the localized one. */
export function imageErrorText(error: Pick<ImageError, "code" | "message">, t: Translate): string {
  return (
    lookup(t, `imageStudio.error.${error.code}`) ??
    (error.message === IMAGE_ERROR_FALLBACK_MESSAGE
      ? t("imageStudio.error.generic")
      : error.message)
  );
}
