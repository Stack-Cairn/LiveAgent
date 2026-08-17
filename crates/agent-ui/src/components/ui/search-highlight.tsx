import { getSearchHighlightRanges } from "@liveagent/ui/lib/shared/fuzzySearch";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { memo, useMemo } from "react";

export const SearchHighlight = memo(function SearchHighlight(props: {
  text: string;
  query: string;
  className?: string;
  markClassName?: string;
}) {
  const { text, query, className, markClassName } = props;
  const ranges = useMemo(() => getSearchHighlightRanges(text, query), [query, text]);

  if (ranges.length === 0) return <span className={className}>{text}</span>;

  let cursor = 0;
  return (
    <span className={className}>
      {ranges.map((range) => {
        const prefix = text.slice(cursor, range.start);
        const match = text.slice(range.start, range.end);
        cursor = range.end;
        return (
          <span key={`${range.start}:${range.end}`}>
            {prefix}
            <mark
              className={cn(
                "rounded-xs bg-amber-300/45 text-inherit dark:bg-amber-400/25",
                markClassName,
              )}
            >
              {match}
            </mark>
          </span>
        );
      })}
      {text.slice(cursor)}
    </span>
  );
});
