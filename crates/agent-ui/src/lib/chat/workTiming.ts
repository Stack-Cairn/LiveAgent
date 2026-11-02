// Chat timestamps are epoch milliseconds. Old history projections used row
// offsets for missing timestamps; those are identities, not clock readings.
const MIN_CHAT_TIMESTAMP = Date.UTC(2000, 0, 1);

export function chatTimestamp(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= MIN_CHAT_TIMESTAMP
    ? value
    : undefined;
}

export function chatDuration(start: number | undefined, end: number | undefined) {
  const from = chatTimestamp(start);
  const to = chatTimestamp(end);
  return from !== undefined && to !== undefined && to >= from ? to - from : undefined;
}

export function workDuration(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
