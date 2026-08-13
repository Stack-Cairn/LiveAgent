const VALUE_SEPARATOR = "::";

export function toModelValue(customProviderId: string, model: string) {
  return `${customProviderId}${VALUE_SEPARATOR}${model}`;
}

export function parseModelValue(value: string): { customProviderId: string; model: string } | null {
  const index = value.indexOf(VALUE_SEPARATOR);
  if (index <= 0) return null;
  const customProviderId = value.slice(0, index);
  const model = value.slice(index + VALUE_SEPARATOR.length);
  if (!model || !customProviderId) return null;
  return { customProviderId, model };
}
