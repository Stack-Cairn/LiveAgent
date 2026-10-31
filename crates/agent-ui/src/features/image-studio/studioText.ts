import { DEFAULT_LOCALE } from "../../i18n/hostTranslations";
import { SHARED_TRANSLATIONS } from "../../i18n/sharedTranslations";
import { IMAGE_ERROR_FALLBACK_MESSAGE } from "../../lib/imaging/errors";
import type { ImageError, ParameterSpec } from "../../lib/imaging/types";

export type Translate = (key: string) => string;

const english: Record<string, string> = SHARED_TRANSLATIONS["en-US"];
const fallback: Record<string, string> = SHARED_TRANSLATIONS[DEFAULT_LOCALE];
/** For code outside a LocaleContext (controller before mount, tests): the default locale. */
export const defaultTranslate: Translate = (key) => fallback[key] ?? key;

/** A parameter is a fixed value, a nested message, or text that depends on the language. */
export type MessageParam = string | number | Message | ((t: Translate) => string);
/**
 * Text kept as a key until it is shown, so a stored notice follows a later language
 * switch. `{name}` placeholders are filled in a single pass: a value that itself
 * contains `{other}` or `$&` (a prompt, a provider message) is inserted verbatim.
 */
export interface Message {
  key: string;
  params?: Record<string, MessageParam>;
}
export const message = (key: string, params?: Record<string, MessageParam>): Message =>
  params ? { key, params } : { key };
export function formatMessage(text: Message, t: Translate): string {
  const params = text.params ?? {};
  return t(text.key).replace(/\{(\w+)\}/g, (token, name: string) => {
    if (!Object.hasOwn(params, name)) return token;
    const value = params[name];
    if (typeof value === "function") return value(t);
    return typeof value === "object" ? formatMessage(value, t) : String(value);
  });
}
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
