const PORTABLE_RELEASE_DATE_PATTERN =
  /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2})(\.\d+)?)?(?:\s*(Z|[+-]\d{2}:\d{2})(?::\d{2})?)?$/i;

function padDatePart(value: number | string) {
  return String(value).padStart(2, "0");
}

function parsePortableReleaseDate(value: string) {
  const match = value.match(PORTABLE_RELEASE_DATE_PATTERN);
  if (!match) return null;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = "", zone] =
    match;
  const year = Number.parseInt(yearText, 10);
  const month = Number.parseInt(monthText, 10);
  const day = Number.parseInt(dayText, 10);
  const hour = Number.parseInt(hourText, 10);
  const minute = Number.parseInt(minuteText, 10);
  const second = secondText ? Number.parseInt(secondText, 10) : 0;

  if (zone) {
    const normalized = `${yearText}-${padDatePart(month)}-${padDatePart(day)}T${padDatePart(
      hour,
    )}:${padDatePart(minute)}:${padDatePart(second)}${fraction}${zone.toUpperCase()}`;
    const date = new Date(normalized);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const date = new Date(year, month - 1, day, hour, minute, second);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute
  ) {
    return null;
  }
  return date;
}

function formatDateTime(date: Date) {
  return `${date.getFullYear()}-${padDatePart(date.getMonth() + 1)}-${padDatePart(
    date.getDate(),
  )} ${padDatePart(date.getHours())}:${padDatePart(date.getMinutes())}`;
}

export function formatReleaseDate(value?: string | null) {
  const trimmed = value?.trim();
  if (!trimmed) return "";

  const portableDate = parsePortableReleaseDate(trimmed);
  if (portableDate) return formatDateTime(portableDate);

  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) return trimmed;
  return formatDateTime(date);
}
