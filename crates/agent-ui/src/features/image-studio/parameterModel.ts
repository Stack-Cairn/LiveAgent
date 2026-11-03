import type { ImageTarget, ParameterSpec } from "../../lib/imaging/types";
import { type Message, message } from "./studioText";

export interface FieldError {
  key: string;
  message: Message;
}
export function parameterError(spec: ParameterSpec, value: unknown): Message | undefined {
  if (value === undefined || value === null || value === "")
    return spec.required ? message("imageStudio.parameterError.required") : undefined;
  if (spec.type === "string" && typeof value !== "string")
    return message("imageStudio.parameterError.text");
  if (spec.type === "boolean" && typeof value !== "boolean")
    return message("imageStudio.parameterError.boolean");
  if (spec.type === "number" || spec.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value))
      return message("imageStudio.parameterError.number");
    if (spec.type === "integer" && !Number.isInteger(value))
      return message("imageStudio.parameterError.integer");
    if (spec.minimum !== undefined && value < spec.minimum)
      return message("imageStudio.parameterError.minimum", { value: spec.minimum });
    if (spec.maximum !== undefined && value > spec.maximum)
      return message("imageStudio.parameterError.maximum", { value: spec.maximum });
  }
  if (!["string", "boolean", "number", "integer"].includes(spec.type))
    return message("imageStudio.parameterError.unsupportedType");
  if (spec.enum && !spec.enum.some((candidate) => candidate === value))
    return message("imageStudio.parameterError.unsupportedValue");
}
export function validateParameters(
  target: ImageTarget,
  params: Record<string, unknown>,
): FieldError[] {
  const errors: FieldError[] = [];
  for (const spec of target.parameters) {
    const error = parameterError(spec, params[spec.key]);
    if (error) errors.push({ key: spec.key, message: error });
  }
  for (const key of Object.keys(params))
    if (!target.parameters.some((spec) => spec.key === key))
      errors.push({ key, message: message("imageStudio.parameterError.unknown") });
  return errors;
}
export function normalizeParameters(
  target: ImageTarget,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...values };
  const compression = target.parameters.find((spec) => spec.key === "output_compression");
  if (compression) {
    if (next.output_format === "jpeg" || next.output_format === "webp") {
      const fallback = compression.default ?? 100;
      if (next.output_compression === undefined && !parameterError(compression, fallback))
        next.output_compression = fallback;
    } else delete next.output_compression;
  }
  return next;
}
export function updateParameterValue(
  target: ImageTarget,
  values: Record<string, unknown>,
  key: string,
  value: unknown,
): Record<string, unknown> {
  const next = { ...values };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return normalizeParameters(target, next);
}
export function defaultParameters(target: ImageTarget): Record<string, unknown> {
  return normalizeParameters(
    target,
    Object.fromEntries(
      target.parameters
        .filter((spec) => spec.default !== undefined && !parameterError(spec, spec.default))
        .map((spec) => [spec.key, spec.default]),
    ),
  );
}
/** A restored job may predate the target's current schema (e.g. `size` before ratio tiers). */
export function keepDeclaredParameters(
  target: ImageTarget,
  params: Record<string, unknown>,
): { values: Record<string, unknown>; dropped: string[] } {
  const values: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    const spec = target.parameters.find((item) => item.key === key);
    if (spec && !parameterError(spec, value)) values[key] = value;
    else dropped.push(key);
  }
  return { values: normalizeParameters(target, values), dropped };
}
export function migrateParameters(
  from: ImageTarget,
  to: ImageTarget,
  params: Record<string, unknown>,
): { values: Record<string, unknown>; dropped: string[] } {
  const values = defaultParameters(to);
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    const old = from.parameters.find((spec) => spec.key === key);
    const next = to.parameters.find((spec) => spec.key === key);
    if (old && next && old.type === next.type && !parameterError(next, value)) values[key] = value;
    else dropped.push(key);
  }
  return { values: normalizeParameters(to, values), dropped };
}
