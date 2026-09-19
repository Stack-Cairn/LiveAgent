import { UI_MOTION_TRANSITION } from "@liveagent/ui/lib/shared/motion";
import { domAnimation, type HTMLMotionProps, LazyMotion, useReducedMotion } from "motion/react";
import * as m from "motion/react-m";

export type MotionDirection = "forward" | "backward" | null;

export function MotionDirectionalPanel(
  props: Omit<HTMLMotionProps<"div">, "animate" | "exit" | "initial"> & {
    panelKey: string;
    direction: MotionDirection;
  },
) {
  const { panelKey, direction, children, ...surfaceProps } = props;
  const prefersReducedMotion = useReducedMotion();
  const shouldAnimate = direction !== null && !prefersReducedMotion;
  const offset = direction === "backward" ? -10 : 10;

  return (
    <LazyMotion features={domAnimation} strict>
      <m.div
        key={panelKey}
        initial={{ opacity: shouldAnimate ? 0 : 1, x: shouldAnimate ? offset : 0 }}
        animate={{ opacity: 1, x: 0 }}
        transition={shouldAnimate ? UI_MOTION_TRANSITION.navigation : UI_MOTION_TRANSITION.instant}
        {...surfaceProps}
      >
        {children}
      </m.div>
    </LazyMotion>
  );
}
