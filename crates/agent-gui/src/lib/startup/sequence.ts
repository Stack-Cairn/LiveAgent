export type StartupLeave = "skip" | "retry";
export type StartupOutcome = "done" | StartupLeave;

export type StartupSteps = {
  /**
   * Connects to K-brain. Every later step needs the backend, so nothing else starts before it
   * resolves. Work the connect does not have to wait for (the host bridge refresh) is handed
   * to `defer` and joins the history check instead.
   */
  connect: (defer: (work: Promise<unknown>) => void) => Promise<unknown>;
  /** Runs once connected, before the history check starts (escape buttons, phase). */
  onConnected?: () => void;
  /** The history check that must finish before the app renders. */
  checkHistory: () => Promise<void>;
  /**
   * Loads the app code. Evaluated while the history check runs, so it is ready to render when
   * the check ends; rendering itself still waits for the check.
   */
  preloadApp: () => Promise<unknown>;
};

export type StartupRun = {
  outcome: StartupOutcome;
  /** The history check; on "skip" it keeps running in the background. */
  history: Promise<void>;
};

/**
 * Connect first, then run the history check, the deferred connect work and the app code load
 * side by side. Resolves when all of them are done or the user leaves the attempt, whichever
 * comes first; a failure of the connect or of the history check rejects, as it did when the
 * steps ran one after another. A failed app code load surfaces when the app is opened.
 */
export async function runStartupSequence(
  steps: StartupSteps,
  left: Promise<StartupLeave>,
): Promise<StartupRun> {
  const deferred: Promise<unknown>[] = [];
  await steps.connect((work) => {
    deferred.push(work.catch(() => undefined));
  });
  steps.onConnected?.();
  const history = steps.checkHistory();
  // Opening the app awaits the same (cached) module load and reports its failure there.
  steps.preloadApp().catch(() => undefined);
  const ready = Promise.all([history, ...deferred]).then(() => "done" as const);
  const outcome = await Promise.race([ready, left]);
  return { outcome, history };
}
