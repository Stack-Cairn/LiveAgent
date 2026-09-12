import { cn } from "@liveagent/ui/lib/shared/utils";
import { type CSSProperties, useLayoutEffect, useRef, useState } from "react";
import {
  BLOCK_GAP,
  BOARD_PAD,
  KEY_GAP,
  KEY_UNIT,
  type KeyboardLayoutId,
  type KeyDef,
  keyWidth,
  NATURAL_WIDTH,
  NAV_ARROW_BOTTOM,
  NAV_ARROW_TOP,
  NAV_MID,
  NAV_TOP,
  NUM_GRID,
  NUM_TOP,
  ROW_A,
  ROW_CTL,
  ROW_FN,
  ROW_GAP_LARGE,
  ROW_NUM,
  ROW_Q,
  ROW_Z,
} from "./ShortcutKeyboardLayout";
import "./ShortcutKeyboard.css";

// CSS owns each palette; the same class is applied to keys, dots and legend.
export const SHORTCUT_KEYBOARD_TONES = [
  "ghk-tone-blue",
  "ghk-tone-violet",
  "ghk-tone-emerald",
  "ghk-tone-amber",
] as const;

/** 键帽上的占用标注：bound=该键是某快捷键主键；hintDots=按下更多修饰键后此修饰键下有组合 */
export interface KeyDecor {
  bound?: { colorClass: string; tag: string; title: string };
  hintDots?: string[];
  hintTitle?: string;
}

function KeyCap(props: {
  def: KeyDef;
  pressed: boolean;
  held: boolean;
  decor?: KeyDecor;
  fill?: boolean;
}) {
  const { def, pressed, held, decor, fill } = props;
  if (!def.code && !def.label) {
    return <div style={{ width: keyWidth(def.units), height: KEY_UNIT }} />;
  }
  const bound = decor?.bound;
  const hintDots = decor?.hintDots ?? [];
  const isEnter = def.code === "Enter" || def.code === "NumpadEnter";
  const className = `ghk-key${isEnter ? " ghk-enter" : ""}${
    bound ? ` ghk-bound ${bound.colorClass}` : ""
  }${pressed ? " ghk-down" : ""}${held && !pressed ? " ghk-held" : ""}`;
  return (
    <div
      className={cn(
        "relative flex items-center justify-center px-2px text-xs font-semibold leading-1p1 text-center",
        className,
      )}
      style={fill ? { width: "100%", height: "100%" } : { width: keyWidth(def.units) }}
      title={bound?.title ?? decor?.hintTitle}
    >
      <span
        className="ghk-klegend"
        style={def.label.length > 3 ? { fontSize: "var(--text-tiny)" } : undefined}
      >
        {def.label}
      </span>
      {bound ? (
        <span className="ghk-tag pointer-events-none absolute left-2px right-2px bottom-2px text-tiny font-semibold leading-1p2 text-center whitespace-nowrap overflow-hidden text-ellipsis">
          {bound.tag}
        </span>
      ) : null}
      {!bound && hintDots.length > 0 ? (
        <span className="ghk-dots pointer-events-none absolute top-3px right-4px flex gap-2px">
          {hintDots.map((tone) => (
            <span key={tone} className={cn("ghk-dot size-5px rounded-full", tone)} />
          ))}
        </span>
      ) : null}
    </div>
  );
}

export function ShortcutKeyboard({
  layout,
  recording,
  pressedCodes,
  heldCodes,
  decorForCode,
}: {
  layout: KeyboardLayoutId;
  recording: boolean;
  pressedCodes: ReadonlySet<string>;
  heldCodes: ReadonlySet<string>;
  decorForCode: (code: string | null) => KeyDecor | undefined;
}) {
  // ResizeObserver only measures here. React remains the owner of every
  // rendered style, including the transformed visual height.
  const outerRef = useRef<HTMLDivElement | null>(null);
  const scalerRef = useRef<HTMLDivElement | null>(null);
  const naturalWidth = NATURAL_WIDTH[layout];
  const [scaleLayout, setScaleLayout] = useState({ scale: 1, naturalHeight: 0 });

  useLayoutEffect(() => {
    const outer = outerRef.current;
    const scaler = scalerRef.current;
    if (!outer || !scaler) return;
    const update = () => {
      const width = outer.clientWidth;
      if (width <= 0) return;
      const nextScale = Math.min(1, width / naturalWidth);
      const naturalHeight = scaler.offsetHeight;
      setScaleLayout((current) =>
        current.scale === nextScale && current.naturalHeight === naturalHeight
          ? current
          : { scale: nextScale, naturalHeight },
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(outer);
    return () => observer.disconnect();
  }, [naturalWidth]);

  function renderRow(defs: KeyDef[], key: string) {
    return (
      <div key={key} className="flex" style={{ gap: KEY_GAP }}>
        {defs.map((def) => (
          <KeyCap
            key={def.id}
            def={def}
            pressed={def.code !== null && pressedCodes.has(def.code)}
            held={def.code !== null && heldCodes.has(def.code)}
            decor={decorForCode(def.code)}
          />
        ))}
      </div>
    );
  }

  function renderMainBlock(withFnRow: boolean) {
    return (
      <div className="flex flex-col" style={{ gap: KEY_GAP }}>
        {withFnRow ? (
          <>
            {renderRow(ROW_FN, "fn")}
            <div style={{ height: ROW_GAP_LARGE - KEY_GAP }} />
          </>
        ) : null}
        {renderRow(ROW_NUM, "num")}
        {renderRow(ROW_Q, "q")}
        {renderRow(ROW_A, "a")}
        {renderRow(ROW_Z, "z")}
        {renderRow(ROW_CTL, "ctl")}
      </div>
    );
  }

  function renderNavBlock() {
    return (
      <div className="flex flex-col" style={{ gap: KEY_GAP }}>
        {renderRow(NAV_TOP, "navtop")}
        <div style={{ height: ROW_GAP_LARGE - KEY_GAP }} />
        {renderRow(NAV_MID[0], "navmid0")}
        {renderRow(NAV_MID[1], "navmid1")}
        <div style={{ height: KEY_UNIT }} />
        {renderRow(NAV_ARROW_TOP, "arrowtop")}
        {renderRow(NAV_ARROW_BOTTOM, "arrowbottom")}
      </div>
    );
  }

  function renderNumBlock() {
    return (
      <div className="flex flex-col" style={{ gap: KEY_GAP }}>
        {renderRow(NUM_TOP, "numtop")}
        <div style={{ height: ROW_GAP_LARGE - KEY_GAP }} />
        <div
          className="grid"
          style={{
            gridTemplateColumns: `repeat(4, ${KEY_UNIT}px)`,
            gridAutoRows: KEY_UNIT,
            gap: KEY_GAP,
          }}
        >
          {NUM_GRID.map((cell) => (
            <div
              key={cell.def.id}
              style={{
                gridRow: cell.tall ? "span 2" : undefined,
                gridColumn: cell.wide ? "span 2" : undefined,
              }}
            >
              <KeyCap
                def={cell.def}
                pressed={cell.def.code !== null && pressedCodes.has(cell.def.code)}
                held={cell.def.code !== null && heldCodes.has(cell.def.code)}
                decor={decorForCode(cell.def.code)}
                fill
              />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={outerRef}
      className="ghk-root overflow-hidden pt-2"
      style={
        {
          "--ghk-key-unit": `${KEY_UNIT}px`,
          // Keep room for the keyboard's projected depth and shadow.
          height:
            scaleLayout.naturalHeight > 0
              ? scaleLayout.naturalHeight * scaleLayout.scale + 44
              : undefined,
        } as CSSProperties
      }
    >
      <div
        ref={scalerRef}
        style={{
          width: naturalWidth,
          transform: `scale(${scaleLayout.scale})`,
          transformOrigin: "top center",
          marginLeft: `calc(50% - ${naturalWidth / 2}px)`,
        }}
      >
        <div className="ghk-stage">
          <div
            className={cn("ghk-board inline-flex", recording && "ghk-rec")}
            style={{ gap: BLOCK_GAP, padding: BOARD_PAD }}
          >
            {renderMainBlock(layout !== "61")}
            {layout !== "61" ? renderNavBlock() : null}
            {layout === "104" ? renderNumBlock() : null}
          </div>
        </div>
      </div>
    </div>
  );
}
