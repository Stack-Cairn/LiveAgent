let fallbackSequence = 0;

function fillFallbackBytes(bytes: Uint8Array) {
  const timestamp = Date.now();
  fallbackSequence = (fallbackSequence + 1) >>> 0;

  for (let index = 0; index < bytes.length; index += 1) {
    const timeByte = Math.floor(timestamp / 2 ** ((index % 6) * 8)) & 0xff;
    const sequenceByte = (fallbackSequence >>> ((index % 4) * 8)) & 0xff;
    bytes[index] = Math.floor(Math.random() * 256) ^ timeByte ^ sequenceByte;
  }
}

/**
 * UUID v4 with fallbacks for legacy/embedded WebViews where crypto.randomUUID
 * is missing or throws when called. The last-resort path is Math.random-based
 * and NOT cryptographically secure — use only for identifiers, never for
 * security tokens or secrets.
 */
export function createUuid(): string {
  const crypto = globalThis.crypto;
  if (typeof crypto?.randomUUID === "function") {
    try {
      return crypto.randomUUID();
    } catch {
      // Some embedded WebViews expose the API but fail when it is called.
    }
  }

  const bytes = new Uint8Array(16);
  if (typeof crypto?.getRandomValues === "function") {
    try {
      crypto.getRandomValues(bytes);
    } catch {
      fillFallbackBytes(bytes);
    }
  } else {
    fillFallbackBytes(bytes);
  }

  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}
