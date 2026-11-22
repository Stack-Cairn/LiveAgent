// A short two-note chime generated with Web Audio (no bundled audio file),
// played when a run finishes while the app is in the background.

/** One sine partial of the chime: frequency (Hz), start offset and decay (s). */
export type ChimeNote = { frequency: number; offset: number; duration: number; gain: number };

// A rising major sixth (E5 -> C#6), soft and short enough not to startle.
export const COMPLETION_CHIME: readonly ChimeNote[] = [
  { frequency: 659.25, offset: 0, duration: 0.45, gain: 0.16 },
  { frequency: 1108.73, offset: 0.12, duration: 0.6, gain: 0.12 },
];

/** Back-to-back completions within this window share one chime. */
export const COMPLETION_SOUND_MIN_INTERVAL_MS = 1500;

type AudioContextLike = Pick<
  AudioContext,
  "currentTime" | "destination" | "state" | "resume" | "createOscillator" | "createGain"
>;

/**
 * Schedules the chime on `context` and returns when it ends (context time).
 * Each note is a sine with a 10 ms attack and an exponential decay, so it
 * starts and stops without clicks.
 */
export function scheduleChime(
  context: AudioContextLike,
  notes: readonly ChimeNote[] = COMPLETION_CHIME,
  volume = 1,
): number {
  const start = context.currentTime + 0.01;
  let end = start;
  for (const note of notes) {
    const at = start + note.offset;
    const stop = at + note.duration;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(note.frequency, at);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, note.gain * volume), at + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, stop);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(at);
    oscillator.stop(stop + 0.02);
    end = Math.max(end, stop);
  }
  return end;
}

export type CompletionSoundPlayer = {
  /** Plays the chime unless one played within the throttle window. */
  play: () => boolean;
  /**
   * Creates / resumes the audio context. Call from a user gesture: engines
   * keep a context created without one suspended, and a backgrounded window
   * gets no gesture to start it later.
   */
  unlock: () => void;
  dispose: () => void;
};

type PlayerOptions = {
  createContext?: () => AudioContextLike | null;
  now?: () => number;
};

function defaultCreateContext(): AudioContextLike | null {
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ??
    (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  return Ctor ? new Ctor() : null;
}

export function createCompletionSoundPlayer(options: PlayerOptions = {}): CompletionSoundPlayer {
  const createContext = options.createContext ?? defaultCreateContext;
  const now = options.now ?? Date.now;
  let context: AudioContextLike | null = null;
  let lastPlayedAt = Number.NEGATIVE_INFINITY;

  const ensureContext = () => {
    if (!context) {
      try {
        context = createContext();
      } catch {
        context = null;
      }
    }
    if (context?.state === "suspended") {
      context.resume().catch(() => {
        // Still locked: the next gesture tries again.
      });
    }
    return context;
  };

  return {
    play: () => {
      const time = now();
      if (time - lastPlayedAt < COMPLETION_SOUND_MIN_INTERVAL_MS) return false;
      const ready = ensureContext();
      if (!ready) return false;
      lastPlayedAt = time;
      try {
        scheduleChime(ready);
        return true;
      } catch {
        return false;
      }
    },
    unlock: () => {
      ensureContext();
    },
    dispose: () => {
      const current = context as (AudioContextLike & { close?: () => Promise<void> }) | null;
      context = null;
      current?.close?.().catch(() => {});
    },
  };
}

let sharedPlayer: CompletionSoundPlayer | null = null;

/** The app-wide player, so the settings preview unlocks the same context. */
export function completionSoundPlayer(): CompletionSoundPlayer {
  sharedPlayer ??= createCompletionSoundPlayer();
  return sharedPlayer;
}
