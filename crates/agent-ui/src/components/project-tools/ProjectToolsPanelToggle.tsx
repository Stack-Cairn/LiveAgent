import { cn } from "@liveagent/ui/lib/shared/utils";
import { PanelRightClose, PanelRightOpen } from "../IconSet";
import { Button } from "../ui/button";

export function ProjectToolsPanelToggle(props: {
  isOpen: boolean;
  sessionCount: number;
  disabledMessage?: string;
  className?: string;
  onToggle: () => void;
}) {
  const { isOpen, sessionCount, disabledMessage, className = "", onToggle } = props;
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={onToggle}
      disabled={Boolean(disabledMessage) && !isOpen}
      aria-expanded={isOpen}
      title={
        isOpen ? "Collapse project tools panel" : (disabledMessage ?? "Expand project tools panel")
      }
      className={cn(
        className,
        "relative size-8 rounded-lg text-muted-foreground transition-[background-color,color,transform] duration-150 hover:text-foreground active:scale-95",
        isOpen ? "bg-muted text-foreground" : "",
      )}
    >
      {isOpen ? <PanelRightClose className="size-4" /> : <PanelRightOpen className="size-4" />}
      {sessionCount > 0 ? (
        <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-emerald-500 px-1 text-scaled-10px font-semibold leading-none text-white">
          {sessionCount}
        </span>
      ) : null}
    </Button>
  );
}
