import { notificationSettingsAvailable } from "@liveagent/adapters/systemSettings";
import type { AppSettings } from "@liveagent/app/lib/settings";
import {
  decideAutoOnboarding,
  markOnboarding,
  type OnboardingStep,
  onboardingEnvironmentFromSettings,
  readOnboardingRecord,
  subscribeOnboardingRequests,
  writeOnboardingRecord,
} from "@liveagent/ui/lib/onboarding/onboardingState";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { OnboardingWorkspaceHost } from "./OnboardingDialog";

const OnboardingDialog = lazy(async () => ({
  default: (await import("./OnboardingDialog")).OnboardingDialog,
}));

export type OnboardingHostProps = {
  settings: AppSettings;
  setSettings: (updater: (prev: AppSettings) => AppSettings) => void;
  /** Decide at startup whether a fresh profile gets the guide. */
  autoStart: boolean;
  /** Existing sessions; a rejection leaves the decision for the next launch. */
  loadSessionCount: () => Promise<number>;
  workspace?: OnboardingWorkspaceHost;
  /** Puts a "try this" prompt into the composer. */
  onInsertPrompt: (prompt: string) => void;
};

type HostState = { open: boolean; step: OnboardingStep; manual: boolean };

/**
 * Owns when the first-run guide shows. Auto-start runs once per launch and
 * only for an unfinished record; anybody with sessions or a working provider
 * and default model is marked auto-skipped and never sees it on their own.
 */
export function OnboardingHost(props: OnboardingHostProps) {
  const { settings, setSettings, autoStart, loadSessionCount, workspace, onInsertPrompt } = props;
  const [state, setState] = useState<HostState>({ open: false, step: "welcome", manual: false });
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const loadSessionCountRef = useRef(loadSessionCount);
  loadSessionCountRef.current = loadSessionCount;

  useEffect(() => {
    if (!autoStart) return;
    const record = readOnboardingRecord();
    if (record && record.status !== "in-progress") return;
    let cancelled = false;
    void loadSessionCountRef
      .current()
      .then(
        (count) => count,
        () => null,
      )
      .then((sessionCount) => {
        if (cancelled) return;
        const env = onboardingEnvironmentFromSettings(settingsRef.current, {
          sessionCount,
          notificationsSupported: notificationSettingsAvailable(),
        });
        const decision = decideAutoOnboarding(record, env);
        if (decision.show) {
          writeOnboardingRecord(markOnboarding("in-progress", decision.step));
          setState({ open: true, step: decision.step, manual: false });
        } else if (decision.reason === "configured") {
          writeOnboardingRecord(markOnboarding("auto-skipped"));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [autoStart]);

  useEffect(
    () =>
      subscribeOnboardingRequests(() => setState({ open: true, step: "welcome", manual: true })),
    [],
  );

  const manual = state.manual;
  const handleStepChange = useCallback(
    (step: OnboardingStep) => {
      // Only the automatic first run resumes after a restart.
      if (!manual) writeOnboardingRecord(markOnboarding("in-progress", step));
    },
    [manual],
  );
  const handleSkip = useCallback((step: OnboardingStep) => {
    writeOnboardingRecord(markOnboarding("skipped", step));
    setState((prev) => ({ ...prev, open: false }));
  }, []);
  const handleFinish = useCallback(
    (prompt?: string) => {
      writeOnboardingRecord(markOnboarding("completed"));
      setState((prev) => ({ ...prev, open: false }));
      // After the dialog hands focus back, so the composer keeps it.
      if (prompt) setTimeout(() => onInsertPrompt(prompt), 150);
    },
    [onInsertPrompt],
  );

  if (!state.open) return null;
  return (
    <Suspense fallback={null}>
      <OnboardingDialog
        open={state.open}
        initialStep={state.step}
        settings={settings}
        setSettings={setSettings}
        workspace={workspace}
        onStepChange={handleStepChange}
        onSkip={handleSkip}
        onFinish={handleFinish}
      />
    </Suspense>
  );
}
