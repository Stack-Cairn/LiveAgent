/** Resolve a 1-based trajectory turn from the authoritative persisted user count. */
export function trajectoryTurnFromPersistedUserCount(
  persistedUserTurns: number,
  currentUserPersisted: boolean,
): number {
  const count = Number.isFinite(persistedUserTurns)
    ? Math.max(0, Math.trunc(persistedUserTurns))
    : 0;
  return Math.max(1, count + (currentUserPersisted ? 0 : 1));
}
