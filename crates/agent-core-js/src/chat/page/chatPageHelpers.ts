export function isAbortLikeError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
