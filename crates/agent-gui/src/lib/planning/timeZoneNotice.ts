export type TimeZoneNotice = {
  /** `device`: following the system, but this device now reports another zone; the zone is
   * read at startup only, so the change applies after a restart. */
  kind: "invalid" | "unsupported" | "mismatch" | "device";
  preference?: string;
  effective?: string;
  device?: string;
};

const notices = new Map<string, TimeZoneNotice>();
const dismissed = new Map<string, string>();
const listeners = new Set<() => void>();
const storageKey = (scope: string) => `liveagent.timezone-notice.dismissed:${scope}`;
const fingerprint = (notice: TimeZoneNotice) => JSON.stringify(notice);

export function subscribeTimeZoneNotice(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit() {
  for (const listener of listeners) listener();
}

export function getTimeZoneNotice(scope: string): TimeZoneNotice | null {
  const notice = notices.get(scope);
  if (!notice) return null;
  let hidden = dismissed.get(scope);
  try {
    hidden ??= globalThis.sessionStorage?.getItem(storageKey(scope)) ?? undefined;
  } catch {
    /* Storage is optional. */
  }
  return hidden === fingerprint(notice) ? null : notice;
}

export function dismissTimeZoneNotice(scope: string) {
  const notice = notices.get(scope);
  if (!notice) return;
  const key = fingerprint(notice);
  dismissed.set(scope, key);
  try {
    globalThis.sessionStorage?.setItem(storageKey(scope), key);
  } catch {
    /* Storage is optional. */
  }
  emit();
}

function update(scope: string, notice: TimeZoneNotice | null) {
  if (JSON.stringify(notices.get(scope) ?? null) === JSON.stringify(notice)) return;
  if (notice) notices.set(scope, notice);
  else {
    notices.delete(scope);
    dismissed.delete(scope);
    try {
      globalThis.sessionStorage?.removeItem(storageKey(scope));
    } catch {
      /* Storage is optional. */
    }
  }
  emit();
}

function canonicalZone(zone: string) {
  try {
    return new Intl.DateTimeFormat("en", { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

/** This device's current zone, as the client runtime sees it. */
function deviceTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
}

function offsetMinutes(zone: string, at: number) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(at);
  const value = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const local = Date.UTC(
    value("year"),
    value("month") - 1,
    value("day"),
    value("hour"),
    value("minute"),
  );
  return Math.round((local - Math.floor(at / 60_000) * 60_000) / 60_000);
}

/** Same clock today and half a year from now (DST differences still count as different). */
function sameClock(a: string, b: string, now = Date.now()) {
  try {
    return [now, now + 182 * 86_400_000].every(
      (at) => offsetMinutes(a, at) === offsetMinutes(b, at),
    );
  } catch {
    return false;
  }
}

// Notices that only a time zone response can raise or clear; unrelated queries keep them.
const STICKY = new Set<TimeZoneNotice["kind"]>(["mismatch", "device"]);

export function reportTimeZoneFailure(scope: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/^E:timezone_invalid(?::|$)/.test(message.trim())) update(scope, { kind: "invalid" });
}

export function observeTimeZoneResponse(
  scope: string,
  action: string,
  result: unknown,
  device: string = deviceTimeZone(),
) {
  if (!result || typeof result !== "object") return;
  const value = result as { preference?: unknown; timeZone?: unknown };
  if (typeof value.timeZone !== "string" || !value.timeZone) return;
  const effective = canonicalZone(value.timeZone);
  if (!effective) {
    update(scope, { kind: "unsupported", effective: value.timeZone });
    return;
  }
  if (action === "timezone.get" || action === "timezone") {
    if (typeof value.preference !== "string") return;
    const preferred = value.preference ? canonicalZone(value.preference) : effective;
    if (preferred !== effective) {
      update(scope, { kind: "mismatch", preference: value.preference, effective: value.timeZone });
      return;
    }
    // Following the system: the backend read the zone at startup. If this device now reports
    // another clock (system zone changed while running), say a restart applies it. A custom
    // zone is an intentional choice and is never flagged here.
    const current = device ? canonicalZone(device) : undefined;
    if (!value.preference && current && current !== effective && !sameClock(current, effective)) {
      update(scope, { kind: "device", effective: value.timeZone, device });
      return;
    }
    update(scope, null);
  } else if (!STICKY.has(notices.get(scope)?.kind as TimeZoneNotice["kind"])) {
    update(scope, null);
  }
}
