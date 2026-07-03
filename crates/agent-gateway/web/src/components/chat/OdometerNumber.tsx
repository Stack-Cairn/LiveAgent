import { cn } from "../../lib/shared/utils";

const DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];

// Rolling-digit odometer. Each digit is a 1em-high viewport over a vertical
// 0-9 strip translated to the current digit; CSS transitions animate value
// changes (both directions) but not the initial paint, so freshly mounted
// digits — including new most-significant columns — appear in place without
// rolling. Columns are keyed by place value from the least-significant end so
// 99 -> 100 keeps the ones/tens columns' identity.
export function OdometerNumber({ value, className }: { value: number; className?: string }) {
  const safe = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  const text = String(safe);
  return (
    <span className={cn("inline-flex tabular-nums leading-none", className)}>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true" className="inline-flex">
        {Array.from(text).map((char, index) => {
          const digit = char.charCodeAt(0) - 48;
          const place = text.length - 1 - index;
          return (
            <span key={`p${place}`} className="inline-block h-[1em] w-[1ch] overflow-hidden">
              <span
                className="flex flex-col transition-transform duration-300 ease-out will-change-transform motion-reduce:transition-none"
                style={{ transform: `translateY(-${digit}em)` }}
              >
                {DIGITS.map((strip) => (
                  <span key={strip} className="flex h-[1em] w-[1ch] items-center justify-center">
                    {strip}
                  </span>
                ))}
              </span>
            </span>
          );
        })}
      </span>
    </span>
  );
}
