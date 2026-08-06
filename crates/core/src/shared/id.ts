export function createUuid(): string {
  return globalThis.crypto.randomUUID();
}
