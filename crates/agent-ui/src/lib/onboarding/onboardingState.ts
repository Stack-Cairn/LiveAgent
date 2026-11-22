/**
 * First-run onboarding state machine.
 *
 * Pure functions only: the dialog renders whatever step these return, and the
 * host persists the record through `writeOnboardingRecord`. Once the record
 * says completed/skipped/auto-skipped the flow never opens on its own again;
 * it can still be opened by hand from Settings or the command palette.
 */
import { type AppSettings, DEFAULT_WORKSPACE_PROJECT_ID } from "../settings/types";

export const ONBOARDING_STEPS = [
  "welcome",
  "provider",
  "model",
  "workspace",
  "safety",
  "notifications",
  "finish",
] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export type OnboardingStatus = "in-progress" | "completed" | "skipped" | "auto-skipped";

export type OnboardingRecord = {
  version: 1;
  status: OnboardingStatus;
  /** Last step shown while in progress; used to resume after a restart. */
  step?: OnboardingStep;
  updatedAt: number;
};

export const ONBOARDING_STORAGE_KEY = "liveagent.onboarding.v1";

export type OnboardingEnvironment = {
  providerCount: number;
  /** Enabled models across all providers. */
  activeModelCount: number;
  /** A default model is selected and still offered by an existing provider. */
  hasValidDefaultModel: boolean;
  /** Workspaces the user added (the built-in default project does not count). */
  userWorkspaceCount: number;
  /** Existing sessions; null while unknown (backend not reachable yet). */
  sessionCount: number | null;
  /** The host can show system notifications (desktop). */
  notificationsSupported: boolean;
};

export type OnboardingDecision =
  | { show: true; step: OnboardingStep; resumed: boolean }
  | { show: false; reason: "finished" | "configured" | "pending" };

export function onboardingSteps(
  env: Pick<OnboardingEnvironment, "notificationsSupported">,
): OnboardingStep[] {
  return ONBOARDING_STEPS.filter((step) => step !== "notifications" || env.notificationsSupported);
}

function isStepSatisfied(step: OnboardingStep, env: OnboardingEnvironment): boolean {
  switch (step) {
    case "provider":
      return env.providerCount > 0;
    case "model":
      return env.hasValidDefaultModel;
    case "workspace":
      return env.userWorkspaceCount > 0;
    default:
      return false;
  }
}

/**
 * Somebody who already chats, or already has a provider with a usable model
 * (set up in the app, imported, or written to the config file before the first
 * launch), does not need the first-run flow; it stays reachable by hand.
 */
export function isAlreadyConfigured(env: OnboardingEnvironment): boolean {
  if ((env.sessionCount ?? 0) > 0) return true;
  return isStepSatisfied("provider", env) && (env.hasValidDefaultModel || env.activeModelCount > 0);
}

/**
 * Where a partially configured profile should start: language/theme only on a
 * truly fresh profile, otherwise the first setup step that is still missing.
 */
export function firstMissingStep(env: OnboardingEnvironment): OnboardingStep {
  if (env.providerCount === 0) return "welcome";
  for (const step of onboardingSteps(env)) {
    if (step === "welcome") continue;
    if (step === "provider" || step === "model" || step === "workspace") {
      if (!isStepSatisfied(step, env)) return step;
      continue;
    }
    return step;
  }
  return "finish";
}

/** Decides whether the flow opens by itself at startup, and at which step. */
export function decideAutoOnboarding(
  record: OnboardingRecord | null,
  env: OnboardingEnvironment,
): OnboardingDecision {
  if (record && record.status !== "in-progress") return { show: false, reason: "finished" };
  if (record?.status === "in-progress" && record.step) {
    const steps = onboardingSteps(env);
    const step = steps.includes(record.step) ? record.step : firstMissingStep(env);
    return { show: true, step, resumed: true };
  }
  // Without session information a returning user could be mistaken for a new one.
  if (env.sessionCount === null) return { show: false, reason: "pending" };
  if (isAlreadyConfigured(env)) return { show: false, reason: "configured" };
  return { show: true, step: firstMissingStep(env), resumed: false };
}

export function nextOnboardingStep(
  steps: readonly OnboardingStep[],
  current: OnboardingStep,
): OnboardingStep {
  const index = steps.indexOf(current);
  if (index < 0) return steps[0] ?? "finish";
  return steps[Math.min(index + 1, steps.length - 1)] ?? "finish";
}

export function previousOnboardingStep(
  steps: readonly OnboardingStep[],
  current: OnboardingStep,
): OnboardingStep | null {
  const index = steps.indexOf(current);
  return index > 0 ? (steps[index - 1] ?? null) : null;
}

export function onboardingProgress(steps: readonly OnboardingStep[], current: OnboardingStep) {
  const index = Math.max(0, steps.indexOf(current));
  return { index, total: steps.length };
}

export function markOnboarding(
  status: OnboardingStatus,
  step?: OnboardingStep,
  now: () => number = Date.now,
): OnboardingRecord {
  return { version: 1, status, ...(step ? { step } : {}), updatedAt: now() };
}

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readOnboardingRecord(
  storage: StorageLike | null = defaultStorage(),
): OnboardingRecord | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(ONBOARDING_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<OnboardingRecord>;
    const statuses: OnboardingStatus[] = ["in-progress", "completed", "skipped", "auto-skipped"];
    if (parsed?.version !== 1 || !statuses.includes(parsed.status as OnboardingStatus)) return null;
    const step = ONBOARDING_STEPS.includes(parsed.step as OnboardingStep)
      ? (parsed.step as OnboardingStep)
      : undefined;
    return {
      version: 1,
      status: parsed.status as OnboardingStatus,
      ...(step ? { step } : {}),
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
    };
  } catch {
    return null;
  }
}

export function writeOnboardingRecord(
  record: OnboardingRecord,
  storage: StorageLike | null = defaultStorage(),
): void {
  try {
    storage?.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Private windows and full quotas: the flow may show again, nothing breaks.
  }
}

/** Derives the onboarding environment from settings plus host facts. */
export function onboardingEnvironmentFromSettings(
  settings: Pick<AppSettings, "customProviders" | "selectedModel" | "system">,
  facts: { sessionCount: number | null; notificationsSupported: boolean },
): OnboardingEnvironment {
  const selected = settings.selectedModel;
  const provider = selected
    ? settings.customProviders.find((candidate) => candidate.id === selected.customProviderId)
    : undefined;
  const hasValidDefaultModel = Boolean(
    provider && selected?.model && provider.activeModels.includes(selected.model),
  );
  const userWorkspaceCount = settings.system.workspaceProjects.filter(
    (project) => project.id !== DEFAULT_WORKSPACE_PROJECT_ID && project.path.trim() !== "",
  ).length;
  return {
    providerCount: settings.customProviders.length,
    activeModelCount: settings.customProviders.reduce(
      (sum, candidate) => sum + candidate.activeModels.length,
      0,
    ),
    hasValidDefaultModel,
    userWorkspaceCount,
    sessionCount: facts.sessionCount,
    notificationsSupported: facts.notificationsSupported,
  };
}

type Listener = () => void;
const listeners = new Set<Listener>();

/** Asks the mounted onboarding host to open the flow from the first step. */
export function requestOnboarding(): void {
  for (const listener of [...listeners]) listener();
}

export function subscribeOnboardingRequests(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
