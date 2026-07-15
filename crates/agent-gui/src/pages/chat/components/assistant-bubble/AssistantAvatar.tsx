import iconSimpleUrl from "../../../../../src-tauri/icons/icon-simple.png";
import { cn } from "../../../../lib/shared/utils";

export function AssistantAvatar(props: { className?: string }) {
  const { className } = props;
  return (
    <div
      className={cn(
        "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border/60 bg-background/80 shadow-none dark:bg-background/70",
        className,
      )}
    >
      <img
        src={iconSimpleUrl}
        alt=""
        aria-hidden="true"
        draggable={false}
        className="h-6 w-6 select-none object-contain"
      />
    </div>
  );
}
