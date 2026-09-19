export const UI_MOTION_EASE = {
  enter: [0.2, 0, 0, 1],
} as const;

export const UI_MOTION_TRANSITION = {
  collapse: {
    duration: 0.22,
    ease: UI_MOTION_EASE.enter,
  },
  feedback: {
    duration: 0.2,
    ease: UI_MOTION_EASE.enter,
  },
  feedbackExit: {
    duration: 0.16,
    ease: [0.4, 0, 1, 1],
  },
  popover: {
    duration: 0.16,
    ease: UI_MOTION_EASE.enter,
  },
  popoverExit: {
    duration: 0.12,
    ease: [0.4, 0, 1, 1],
  },
  navigation: {
    duration: 0.2,
    ease: UI_MOTION_EASE.enter,
  },
  instant: {
    duration: 0,
  },
} as const;
