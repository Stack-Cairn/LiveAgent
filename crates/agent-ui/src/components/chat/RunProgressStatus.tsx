import { useLocale } from "../../i18n/index";
import { parseRunProgress } from "../../lib/chat/runProgress";
import { Loader2 } from "../IconSet";

export function RunProgressStatus({ status }: { status: string | null }) {
  const { t } = useLocale();
  const progress = parseRunProgress(status);
  if (!progress) return null;
  const seconds = (ms: number) => `${(ms / 1000).toFixed(2)} s`;
  const timings = [
    ["elapsed_ms", "backend"],
    ["model_request_ms", "modelRequest"],
    ["first_thinking_ms", "firstThinking"],
    ["first_text_ms", "firstText"],
    ["client_first_text_ms", "clientFirstText"],
  ] as const;
  return (
    <details
      className="min-w-0 max-w-full text-xs text-muted-foreground"
      data-run-progress={progress.stage}
    >
      <summary className="cursor-pointer break-words" aria-live="polite">
        <Loader2
          aria-hidden="true"
          className="mr-1.5 inline-block size-3 shrink-0 animate-spin align-[-2px] motion-reduce:animate-none"
        />
        {t(`chat.runProgress.${progress.stage}`)}
        {progress.elapsed_ms === undefined ? "" : ` · ${seconds(progress.elapsed_ms)}`}
      </summary>
      <dl className="mt-1 grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1">
        {timings.map(([key, label]) =>
          progress[key] === undefined ? null : (
            <div className="contents" key={key}>
              <dt className="break-words">{t(`chat.runProgress.${label}`)}</dt>
              <dd>{seconds(progress[key])}</dd>
            </div>
          ),
        )}
      </dl>
    </details>
  );
}
