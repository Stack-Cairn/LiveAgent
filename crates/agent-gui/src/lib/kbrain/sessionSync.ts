import type { KBrainClient } from "./client";
import type { KBrainSession, KBrainSessionChanges, KBrainSessionWorkdir } from "./types";

const UINT64_MAX = 18_446_744_073_709_551_615n;
const MAX_BASELINE_SESSIONS = 100_000;

export function sessionSyncRevision(value: unknown): bigint {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,19})$/.test(value)) {
    throw new Error("Malformed K-brain sync revision");
  }
  const revision = BigInt(value);
  if (revision > UINT64_MAX) throw new Error("K-brain sync revision exceeds uint64");
  return revision;
}

type SyncClient = Pick<
  KBrainClient,
  | "getCapabilities"
  | "createSessionSnapshot"
  | "getSessionSnapshot"
  | "releaseSessionSnapshot"
  | "getSessionChanges"
>;

export type KBrainSessionSyncSnapshot = {
  epoch: string;
  revision: string;
  sessions: ReadonlyMap<string, KBrainSession>;
  workdirs: KBrainSessionWorkdir[];
  deletedSessionIds?: string[];
};

export type SessionSyncOptions = {
  client: SyncClient;
  onSnapshot(snapshot: KBrainSessionSyncSnapshot): void;
  /**
   * Receives already validated live changes after the initial authoritative
   * snapshot. Keeping this separate from onSnapshot prevents every small
   * mutation from rebuilding the entire sidebar projection.
   */
  onChanges?(input: {
    epoch: string;
    revision: string;
    changes: ReadonlyArray<KBrainSessionChanges["changes"][number]>;
    workdirs: KBrainSessionWorkdir[];
  }): void;
  onHealth(healthy: boolean, error?: unknown): void;
  retryMs?: number;
  legacyProbeMs?: number;
  random?: () => number;
  requestTimeoutMs?: number;
};

function validSession(session: KBrainSession): boolean {
  return (
    !!session &&
    typeof session.id === "string" &&
    !!session.id.trim() &&
    !!session.model &&
    typeof session.model.provider === "string" &&
    typeof session.model.model === "string" &&
    typeof session.created_at === "string" &&
    typeof session.updated_at === "string" &&
    Number.isFinite(Date.parse(session.created_at)) &&
    Number.isFinite(Date.parse(session.updated_at)) &&
    Number.isSafeInteger(session.message_count) &&
    session.message_count >= 0
  );
}

function summarizeWorkdirs(sessions: ReadonlyMap<string, KBrainSession>): KBrainSessionWorkdir[] {
  const workdirs = new Map<string, KBrainSessionWorkdir>();
  for (const session of sessions.values()) {
    if (!session.cwd?.trim()) continue;
    const previous = workdirs.get(session.cwd);
    workdirs.set(session.cwd, {
      cwd: session.cwd,
      count: (previous?.count ?? 0) + 1,
      updated_at:
        !previous || Date.parse(session.updated_at) > Date.parse(previous.updated_at)
          ? session.updated_at
          : previous.updated_at,
    });
  }
  return [...workdirs.values()];
}

function applyChanges(
  response: KBrainSessionChanges,
  epoch: string,
  since: string,
  sessions: Map<string, KBrainSession>,
): string {
  if (response.reset) throw new Error("K-brain sync reset required");
  if (
    response.epoch !== epoch ||
    !Array.isArray(response.changes) ||
    typeof response.more !== "boolean" ||
    response.changes.length > 500
  ) {
    throw new Error("Malformed K-brain changes response");
  }
  const head = sessionSyncRevision(response.head_revision);
  const next = sessionSyncRevision(response.next_since);
  let last = sessionSyncRevision(since);
  if (next < last || head < next) throw new Error("K-brain sync cursor moved backwards");
  // Validate the entire batch before changing the caller's temporary state.
  for (const change of response.changes) {
    const revision = sessionSyncRevision(change.revision);
    if (
      !change.id?.trim() ||
      revision <= last ||
      revision > head ||
      (change.kind !== "delete" && change.kind !== "upsert")
    ) {
      throw new Error("Malformed K-brain change sequence");
    }
    if (
      change.kind === "upsert" &&
      (typeof change.listed !== "boolean" ||
        !validSession(change.session) ||
        change.session.id !== change.id)
    ) {
      throw new Error("Malformed K-brain change summary");
    }
    last = revision;
  }
  if (
    next !== last ||
    (!response.more && head > next) ||
    (response.more && response.changes.length === 0)
  ) {
    throw new Error("K-brain changes skipped an undelivered revision");
  }
  for (const change of response.changes) {
    if (change.kind === "delete" || !change.listed) sessions.delete(change.id);
    else sessions.set(change.id, change.session);
  }
  if (sessions.size > MAX_BASELINE_SESSIONS)
    throw new Error("K-brain sync baseline exceeds capacity");
  return next.toString();
}

/** One cancellable owner per backend identity. Snapshot data stays private until
 * every page and the finite initial catch-up have succeeded. */
export function createKBrainSessionSync(options: SessionSyncOptions) {
  let owners = 0;
  let generation = 0;
  let abort: AbortController | undefined;
  let task: Promise<void> | undefined;
  let current: KBrainSessionSyncSnapshot | undefined;
  let healthy = false;
  let forceRescan = false;
  let pollAbort: AbortController | undefined;
  const revisionWaiters = new Set<{
    epoch: string;
    revision: bigint;
    done(error?: Error): void;
  }>();
  const health = (value: boolean, error?: unknown) => {
    if (healthy === value && !error) return;
    healthy = value;
    options.onHealth(value, error);
    if (!value) {
      for (const waiter of [...revisionWaiters])
        waiter.done(new Error("K-brain sync confirmation unavailable"));
    }
  };
  const publish = (snapshot: KBrainSessionSyncSnapshot) => {
    // The live changes loop mutates its private working map. Never expose that
    // map to consumers or a later change would mutate an older snapshot.
    current = { ...snapshot, sessions: new Map(snapshot.sessions) };
    options.onSnapshot(current);
    for (const waiter of [...revisionWaiters]) {
      if (waiter.epoch !== snapshot.epoch) waiter.done(new Error("K-brain sync epoch changed"));
      else if (sessionSyncRevision(snapshot.revision) >= waiter.revision) waiter.done();
    }
  };
  const publishChanges = (
    epoch: string,
    revision: string,
    changes: ReadonlyArray<KBrainSessionChanges["changes"][number]>,
    sessions: Map<string, KBrainSession>,
  ) => {
    const workdirs = summarizeWorkdirs(sessions);
    if (current) {
      current = {
        ...current,
        revision,
        sessions: new Map(sessions),
        workdirs,
        deletedSessionIds: changes
          .filter((change) => change.kind === "delete")
          .map((change) => change.id),
      };
    }
    if (options.onChanges) options.onChanges({ epoch, revision, changes, workdirs });
    else {
      // Preserve the old callback contract for focused consumers that do not
      // opt into the incremental path.
      options.onSnapshot({
        epoch,
        revision,
        sessions: new Map(sessions),
        workdirs,
        deletedSessionIds: changes
          .filter((change) => change.kind === "delete")
          .map((change) => change.id),
      });
    }
    for (const waiter of [...revisionWaiters]) {
      if (waiter.epoch !== epoch) waiter.done(new Error("K-brain sync epoch changed"));
      else if (sessionSyncRevision(revision) >= waiter.revision) waiter.done();
    }
  };
  const delay = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener("abort", done, { once: true });
    });
  const run = async (id: number, signal: AbortSignal) => {
    let failures = 0;
    while (!signal.aborted && id === generation) {
      try {
        const initializationSignal = AbortSignal.any([
          signal,
          AbortSignal.timeout(options.requestTimeoutMs ?? 45_000),
        ]);
        const capabilities = await options.client.getCapabilities(initializationSignal);
        if (signal.aborted) return;
        if (typeof capabilities.session_changes !== "number" || capabilities.session_changes < 2) {
          health(false);
          await delay(options.legacyProbeMs ?? 300_000, signal);
          continue;
        }
        const snapshot = await options.client.createSessionSnapshot(initializationSignal);
        const epoch = snapshot.epoch;
        let since = snapshot.revision;
        sessionSyncRevision(since);
        if (
          !epoch ||
          !snapshot.snapshot_id ||
          !Number.isSafeInteger(snapshot.total_count) ||
          snapshot.total_count < 0 ||
          snapshot.total_count > MAX_BASELINE_SESSIONS
        ) {
          throw new Error("Malformed K-brain snapshot");
        }
        const sessions = new Map<string, KBrainSession>();
        const deletedSessionIds = new Set<string>();
        try {
          let offset = 0;
          while (true) {
            const page = await options.client.getSessionSnapshot(
              snapshot.snapshot_id,
              offset,
              initializationSignal,
            );
            if (signal.aborted) return;
            if (
              page.epoch !== epoch ||
              page.revision !== since ||
              page.snapshot_id !== snapshot.snapshot_id ||
              page.total_count !== snapshot.total_count ||
              !Array.isArray(page.sessions) ||
              page.sessions.length > 500
            ) {
              throw new Error("K-brain snapshot pages do not share one baseline");
            }
            for (const session of page.sessions) {
              if (!validSession(session) || sessions.has(session.id))
                throw new Error("Duplicate or invalid snapshot session");
              sessions.set(session.id, session);
            }
            if (page.next_offset === null) break;
            if (
              !Number.isSafeInteger(page.next_offset) ||
              page.next_offset !== offset + page.sessions.length ||
              page.next_offset <= offset ||
              page.next_offset > snapshot.total_count
            ) {
              throw new Error("K-brain snapshot pagination did not advance");
            }
            offset = page.next_offset;
          }
          if (sessions.size !== snapshot.total_count)
            throw new Error("Incomplete K-brain snapshot");
          let target: bigint | undefined;
          do {
            const changes = await options.client.getSessionChanges(
              { epoch, since, wait: 0 },
              initializationSignal,
            );
            if (signal.aborted) return;
            target ??= sessionSyncRevision(changes.head_revision);
            since = applyChanges(changes, epoch, since, sessions);
            for (const change of changes.changes) {
              if (change.kind === "delete") deletedSessionIds.add(change.id);
              else deletedSessionIds.delete(change.id);
            }
            if (sessionSyncRevision(since) < target && changes.changes.length === 0) {
              throw new Error("K-brain catch-up cannot reach its snapshot head");
            }
          } while (sessionSyncRevision(since) < target);
        } finally {
          // Releasing a token is best-effort; it has an independent server TTL.
          void options.client.releaseSessionSnapshot(snapshot.snapshot_id).catch(() => undefined);
        }
        if (signal.aborted || id !== generation) return;
        publish({
          epoch,
          revision: since,
          sessions,
          workdirs: summarizeWorkdirs(sessions),
          deletedSessionIds: [...deletedSessionIds],
        });
        health(true);
        failures = 0;
        while (!signal.aborted && id === generation) {
          const pendingPoll = new AbortController();
          pollAbort = pendingPoll;
          const requestSignal = AbortSignal.any([
            signal,
            pendingPoll.signal,
            AbortSignal.timeout(options.requestTimeoutMs ?? 45_000),
          ]);
          const rescan = forceRescan;
          forceRescan = false;
          let changes: KBrainSessionChanges;
          try {
            changes = await options.client.getSessionChanges(
              { epoch, since, wait: 30, rescan },
              requestSignal,
            );
          } catch (error) {
            if (!signal.aborted && pendingPoll.signal.aborted && forceRescan) continue;
            if (!signal.aborted && rescan && (error as { status?: number })?.status === 429) {
              // Focus bursts can be throttled without invalidating the live
              // baseline. Keep its cursor and retry the same rescan safely.
              forceRescan = true;
              await delay(
                Math.max(1, (error as { retryAfterMs?: number }).retryAfterMs ?? 1_000),
                signal,
              );
              continue;
            }
            throw error;
          } finally {
            if (pollAbort === pendingPoll) pollAbort = undefined;
          }
          if (signal.aborted || id !== generation) return;
          since = applyChanges(changes, epoch, since, sessions);
          if (changes.changes.length) {
            publishChanges(epoch, since, changes.changes, sessions);
          }
          // more is drained immediately, without creating a second poll loop.
          while (changes.more && !signal.aborted) {
            const more = await options.client.getSessionChanges(
              { epoch, since, wait: 0 },
              AbortSignal.any([signal, AbortSignal.timeout(options.requestTimeoutMs ?? 45_000)]),
            );
            if (signal.aborted || id !== generation) return;
            since = applyChanges(more, epoch, since, sessions);
            if (more.changes.length) publishChanges(epoch, since, more.changes, sessions);
            if (!more.more) break;
          }
        }
      } catch (error) {
        if (signal.aborted || id !== generation) return;
        health(false, error);
        failures += 1;
        const retry = options.retryMs ?? Math.min(30_000, 1_000 * 2 ** Math.min(failures - 1, 5));
        const retryAfter = (error as { retryAfterMs?: number })?.retryAfterMs ?? 0;
        await delay(
          Math.max(retryAfter, retry * (0.8 + (options.random ?? Math.random)() * 0.4)),
          signal,
        );
      }
    }
  };
  const launch = () => {
    if (!owners || task) return;
    const id = ++generation;
    abort = new AbortController();
    task = run(id, abort.signal).finally(() => {
      task = undefined;
      if (owners && id !== generation) launch();
    });
  };
  return {
    acquire() {
      owners += 1;
      launch();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        owners -= 1;
        if (!owners) {
          generation += 1;
          abort?.abort();
          current = undefined;
          health(false);
        }
      };
    },
    restart() {
      forceRescan = true;
      generation += 1;
      abort?.abort();
      health(false);
      launch();
    },
    requestRescan() {
      forceRescan = true;
      pollAbort?.abort();
    },
    getSnapshot: () => current,
    isHealthy: () => healthy,
    waitForRevision(epoch: string, revision: string): Promise<void> {
      const target = sessionSyncRevision(revision);
      if (current?.epoch === epoch && sessionSyncRevision(current.revision) >= target)
        return Promise.resolve();
      if (!healthy || revisionWaiters.size >= 64)
        return Promise.reject(new Error("K-brain sync confirmation unavailable"));
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => waiter.done(new Error("K-brain mutation result needs reconciliation")),
          10_000,
        );
        const waiter = {
          epoch,
          revision: target,
          done(error?: Error) {
            clearTimeout(timer);
            revisionWaiters.delete(waiter);
            if (error) reject(error);
            else resolve();
          },
        };
        revisionWaiters.add(waiter);
      });
    },
  };
}
