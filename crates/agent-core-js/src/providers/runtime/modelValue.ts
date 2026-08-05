const VALUE_SEP = "::";

export function toModelValue(customProviderId: string, model: string) {
  return `${customProviderId}${VALUE_SEP}${model}`;
}

export function parseModelValue(value: string): { customProviderId: string; model: string } | null {
  const idx = value.indexOf(VALUE_SEP);
  if (idx <= 0) return null;
  const customProviderId = value.slice(0, idx);
  const model = value.slice(idx + VALUE_SEP.length);
  if (!model || !customProviderId) return null;
  return { customProviderId, model };
}
