import { Loader2 } from "@liveagent/ui/components/IconSet";
import {
  AlertDialog,
  AlertDialogActions,
  AlertDialogBody,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@liveagent/ui/components/ui/alert-dialog";
import { Button } from "@liveagent/ui/components/ui/button";
import { useLocale } from "@liveagent/ui/i18n/index";
import type { SandboxSetupOutcome } from "@liveagent/ui/lib/kbrain/sandboxSetup";
import { type ReactNode, useEffect, useRef, useState } from "react";

const UNINSTALL_COMMAND = "kn sandbox uninstall";

type Phase =
  | { kind: "confirm" }
  | { kind: "running" }
  | { kind: "done"; outcome: SandboxSetupOutcome };

/** Title and explanation for each setup outcome; detail is K-brain's own text. */
export function sandboxSetupOutcomeMessage(
  outcome: SandboxSetupOutcome,
  t: (key: string) => string,
): { title: string; description: string; detail?: string } {
  const withCommand = (key: string) => t(key).replace("{command}", UNINSTALL_COMMAND);
  switch (outcome.status) {
    case "ready":
      return { title: t("chat.safety.setup.ready"), description: t("chat.safety.setup.readyDesc") };
    case "incomplete":
      return {
        title: t("chat.safety.setup.incomplete"),
        description: t("chat.safety.setup.incompleteDesc"),
        ...(outcome.hint ? { detail: outcome.hint } : {}),
      };
    case "declined":
      return {
        title: t("chat.safety.setup.declined"),
        description: t("chat.safety.setup.declinedDesc"),
      };
    case "busy":
      return { title: t("chat.safety.setup.busy"), description: t("chat.safety.setup.busyDesc") };
    case "failed":
      return {
        title: t("chat.safety.setup.failed"),
        description: withCommand("chat.safety.setup.failedDesc"),
        ...(outcome.message ? { detail: outcome.message } : {}),
      };
    case "unsupported":
      return {
        title: t("chat.safety.setup.unsupported"),
        description: t("chat.safety.setup.unsupportedDesc"),
      };
    default:
      return { title: t("chat.safety.setup.error"), description: "", detail: outcome.message };
  }
}

function Detail(props: { children: ReactNode }) {
  return (
    <div className="break-words rounded-md bg-muted/50 px-2.5 py-1.5 font-mono text-xs leading-5 text-muted-foreground">
      {props.children}
    </div>
  );
}

/**
 * Confirms, runs and reports K-brain's Windows sandbox setup. The request waits on
 * a UAC prompt, so the dialog cannot be dismissed while it runs. Give it a new key
 * for each opening so it starts again at the confirmation.
 */
export function OfflineSandboxSetupDialog(props: {
  open: boolean;
  /** K-brain's run_sandbox.setup_hint, shown before the user decides. */
  hint?: string;
  onOpenChange: (open: boolean) => void;
  onRun: () => Promise<SandboxSetupOutcome>;
  /** Selects the offline sandbox after a successful setup. */
  onUseOffline: () => void;
}) {
  const { open, hint, onOpenChange, onRun, onUseOffline } = props;
  const { t } = useLocale();
  const [phase, setPhase] = useState<Phase>({ kind: "confirm" });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const running = phase.kind === "running";
  const run = async () => {
    setPhase({ kind: "running" });
    let outcome: SandboxSetupOutcome;
    try {
      outcome = await onRun();
    } catch (error) {
      outcome = {
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      };
    }
    if (mounted.current) setPhase({ kind: "done", outcome });
  };

  const result = phase.kind === "done" ? sandboxSetupOutcomeMessage(phase.outcome, t) : null;
  const ready = phase.kind === "done" && phase.outcome.status === "ready";
  const canRetry = phase.kind === "done" && !ready && phase.outcome.status !== "unsupported";

  const close = (
    <AlertDialogClose render={<Button type="button" variant="outline" className="h-8" />}>
      {phase.kind === "confirm" ? t("chat.safety.setup.cancel") : t("chat.safety.setup.close")}
    </AlertDialogClose>
  );

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && running) return;
        onOpenChange(next);
      }}
    >
      <AlertDialogContent className="max-w-md" data-testid="offline-sandbox-setup-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle className="break-words leading-snug">
            {phase.kind === "confirm"
              ? t("chat.safety.setup.title")
              : running
                ? t("chat.safety.setup.running")
                : result?.title}
          </AlertDialogTitle>
        </AlertDialogHeader>
        <AlertDialogBody className="pt-0">
          <AlertDialogDescription className="space-y-2.5" render={<div />}>
            {phase.kind === "confirm" ? (
              <>
                <p className="text-sm leading-relaxed text-foreground">
                  {t("chat.safety.setup.intro")}
                </p>
                <ul className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-foreground">
                  <li>{t("chat.safety.setup.accounts")}</li>
                  <li>{t("chat.safety.setup.firewall")}</li>
                  <li>{t("chat.safety.setup.admin")}</li>
                </ul>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {t("chat.safety.setup.undo")
                    .split("{command}")
                    .flatMap((part, index) =>
                      index === 0
                        ? [part]
                        : [
                            <code key="command" className="rounded bg-muted px-1 font-mono">
                              {UNINSTALL_COMMAND}
                            </code>,
                            part,
                          ],
                    )}
                </p>
                {hint ? (
                  <Detail>{t("chat.safety.setup.backendNote").replace("{hint}", hint)}</Detail>
                ) : null}
              </>
            ) : running ? (
              <div className="flex items-start gap-2.5 text-sm leading-relaxed text-foreground">
                <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" />
                <span>{t("chat.safety.setup.runningDesc")}</span>
              </div>
            ) : result ? (
              <>
                {result.description ? (
                  <p className="text-sm leading-relaxed text-foreground">{result.description}</p>
                ) : null}
                {result.detail ? <Detail>{result.detail}</Detail> : null}
              </>
            ) : null}
          </AlertDialogDescription>
        </AlertDialogBody>
        <AlertDialogFooter>
          <AlertDialogActions>
            {running ? (
              <Button type="button" className="h-8" disabled>
                <Loader2 className="size-3.5 animate-spin" />
                {t("chat.safety.setup.confirm")}
              </Button>
            ) : phase.kind === "confirm" ? (
              <>
                {close}
                <Button type="button" className="h-8" onClick={run}>
                  {t("chat.safety.setup.confirm")}
                </Button>
              </>
            ) : (
              <>
                {close}
                {ready ? (
                  <Button
                    type="button"
                    className="h-8"
                    onClick={() => {
                      onUseOffline();
                      onOpenChange(false);
                    }}
                  >
                    {t("chat.safety.setup.useOffline")}
                  </Button>
                ) : canRetry ? (
                  <Button type="button" className="h-8" onClick={run}>
                    {t("chat.safety.setup.retry")}
                  </Button>
                ) : null}
              </>
            )}
          </AlertDialogActions>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
