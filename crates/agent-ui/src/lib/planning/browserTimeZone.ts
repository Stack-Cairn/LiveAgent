/**
 * Browser clients: an automatic calendar time zone means this computer's zone.
 *
 * K-brain resolves an automatic preference to the backend host's zone and shares one
 * preference across clients, so browsers apply their own zone to the responses they read
 * instead of writing the shared preference (which would change desktop clients too). A custom
 * zone is used as is. Shared by the direct HTTP host (agent-gui) and the Gateway WebUI.
 *
 * Like the rest of the app, the zone is read once at startup: a change while running is not
 * applied until the next start (the GUI's time zone banner tells the user to restart).
 */

const PREFERENCE_TTL_MS = 60_000;
const preferences = new Map<string, { value: Promise<string | null>; at: number }>();

/** This device's zone right now. */
export function browserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
}

/** This device's zone when the app started; the calendar keeps showing it until a restart. */
export const startupTimeZone = browserTimeZone();

/** Remember the shared preference from a time zone response ("" = automatic). */
export function rememberTimeZonePreference(scope: string, preference: string) {
  preferences.set(scope, { value: Promise.resolve(preference), at: Date.now() });
}

/** The shared preference, read at most once a minute per scope; null when it cannot be read. */
export function timeZonePreference(
  scope: string,
  read: () => Promise<{ preference?: unknown } | null | undefined>,
): Promise<string | null> {
  const cached = preferences.get(scope);
  if (cached && Date.now() - cached.at < PREFERENCE_TTL_MS) return cached.value;
  const value = read().then(
    (result) => (typeof result?.preference === "string" ? result.preference : null),
    () => null,
  );
  preferences.set(scope, { value, at: Date.now() });
  return value;
}

/** Applies the browser zone to a response when the preference is automatic. */
export function followBrowserTimeZone<T>(
  action: string,
  result: T,
  preference: string | null,
  zone: string = startupTimeZone,
): T {
  if (preference !== "" || !zone || !result || typeof result !== "object") return result;
  const value = result as Record<string, unknown>;
  if (action === "timezone.get" || action === "timezone") {
    return { ...value, timeZone: zone, systemTimeZone: zone } as T;
  }
  if (action === "query" && typeof value.timeZone === "string") {
    return { ...value, timeZone: zone } as T;
  }
  return result;
}

/**
 * One planning response as a browser client should see it. `readSettings` fetches
 * `timezone.get` (used for queries when the preference is not cached yet).
 */
export async function followBrowserPlanning<T>(
  scope: string,
  action: string,
  result: T,
  readSettings: () => Promise<{ preference?: unknown } | null | undefined>,
): Promise<T> {
  if (action === "timezone.get" || action === "timezone") {
    const preference = (result as { preference?: unknown } | null)?.preference;
    if (typeof preference !== "string") return result;
    rememberTimeZonePreference(scope, preference);
    return followBrowserTimeZone(action, result, preference);
  }
  if (action !== "query") return result;
  return followBrowserTimeZone(action, result, await timeZonePreference(scope, readSettings));
}
