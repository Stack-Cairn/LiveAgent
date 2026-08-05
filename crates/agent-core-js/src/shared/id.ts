export function createUuid(): string {
  return crypto.randomUUID?.() ?? '';
}
