export type IntegerDraftOptions = {
  min?: number;
  max?: number;
};

export function normalizeIntegerDraftInput(input: string): string {
  return input.replace(/\D+/g, "");
}

export function parseIntegerDraftValue(
  input: string,
  options: IntegerDraftOptions = {},
): number | null {
  const draft = normalizeIntegerDraftInput(input);
  if (!draft) return null;

  const value = Number.parseInt(draft, 10);
  if (!Number.isFinite(value)) return null;

  const min = options.min ?? 1;
  if (value < min) return null;

  const max = options.max;
  if (typeof max === "number" && value > max) {
    return max;
  }

  return Number.isSafeInteger(value) ? value : null;
}
