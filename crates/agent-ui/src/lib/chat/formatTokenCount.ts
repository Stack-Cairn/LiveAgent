const tokenCountFormatterByLocale = new Map<string, Intl.NumberFormat>();

function getTokenCountFormatter(locale: string): Intl.NumberFormat {
  const cached = tokenCountFormatterByLocale.get(locale);
  if (cached) return cached;

  const formatter = new Intl.NumberFormat(locale, {
    maximumFractionDigits: 2,
    useGrouping: false,
  });
  tokenCountFormatterByLocale.set(locale, formatter);
  return formatter;
}

export function formatTokenCount(value: number, locale: string): string {
  const roundedValue = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  const formatter = getTokenCountFormatter(locale);
  if (roundedValue < 1_000) {
    return formatter.format(roundedValue);
  }
  return `${formatter.format(roundedValue / 1_000)}K`;
}
