import {
  FrostSpinner,
  LoadingSurface,
  LoadingTrack,
} from "@liveagent/ui/components/hub/HubLoading";
import { SKILLS_SCAN_DOTS_CLASS } from "@liveagent/ui/components/hub/hubMotionStyles";
import { Skeleton } from "@liveagent/ui/components/ui/skeleton";

export function ScanActivityDots() {
  return (
    <span className={`ml-0.5 inline-flex gap-2px ${SKILLS_SCAN_DOTS_CLASS}`} aria-hidden="true">
      <span className="skills-scan-dot size-1 rounded-full bg-foreground/55" />
      <span className="skills-scan-dot size-1 rounded-full bg-foreground/55" />
      <span className="skills-scan-dot size-1 rounded-full bg-foreground/55" />
    </span>
  );
}

export function SkillsContentLoadingState(props: { title: string; description: string }) {
  const { title, description } = props;
  return (
    <div className="flex flex-col gap-3" role="status" aria-live="polite" aria-busy="true">
      <LoadingSurface variant="hero" className="px-4 py-3.5">
        <div className="flex items-center gap-3.5">
          <FrostSpinner />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium tracking-tight text-foreground">{title}</div>
            <div className="mt-0.5 truncate text-xs text-muted-foreground/80">{description}</div>
          </div>
        </div>
        <LoadingTrack className="mt-3.5" />
      </LoadingSurface>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
        {[1, 2, 3, 4, 5, 6].map((item) => (
          <LoadingSurface variant="skeleton" key={item} className="p-3.5">
            <div className="flex items-center gap-3">
              <Skeleton className="size-9 shrink-0 rounded-lg" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3.5 w-28 rounded" />
                <Skeleton className="h-3 w-full max-w-48 rounded" />
              </div>
            </div>
          </LoadingSurface>
        ))}
      </div>
    </div>
  );
}
