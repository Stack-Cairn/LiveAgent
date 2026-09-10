export const UI_MOTION_EASE = {
  enter: [0.2, 0, 0, 1],
} as const;

export const UI_MOTION_TRANSITION = {
  collapse: {
    duration: 0.22,
    ease: UI_MOTION_EASE.enter,
  },
  instant: {
    duration: 0,
  },
} as const;
