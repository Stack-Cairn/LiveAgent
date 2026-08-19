export const DEFAULT_TRAJECTORY_DETAILS_WIDTH = 420;
export const MIN_TRAJECTORY_DETAILS_WIDTH = 160;
export const MAX_TRAJECTORY_DETAILS_WIDTH = 720;
export const MIN_TRAJECTORY_TABLE_WIDTH = 140;

const TRAJECTORY_DETAILS_KEYBOARD_STEP = 24;
const TRAJECTORY_DETAILS_KEYBOARD_LARGE_STEP = 72;

export function trajectoryDetailsWidthBounds(containerWidth: number) {
  const availableWidth = Math.max(0, containerWidth);
  const min = Math.min(
    MIN_TRAJECTORY_DETAILS_WIDTH,
    Math.max(0, availableWidth - MIN_TRAJECTORY_TABLE_WIDTH),
  );
  const max = Math.max(
    min,
    Math.min(MAX_TRAJECTORY_DETAILS_WIDTH, availableWidth - MIN_TRAJECTORY_TABLE_WIDTH),
  );
  return { min, max };
}

export function clampTrajectoryDetailsWidth(width: number, containerWidth: number) {
  const bounds = trajectoryDetailsWidthBounds(containerWidth);
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(width)));
}

export function resolveTrajectoryDetailsDragWidth(
  startWidth: number,
  horizontalDelta: number,
  containerWidth: number,
) {
  return clampTrajectoryDetailsWidth(startWidth - horizontalDelta, containerWidth);
}

export function resolveTrajectoryDetailsKeyboardWidth(
  key: string,
  width: number,
  containerWidth: number,
  largeStep: boolean,
) {
  const bounds = trajectoryDetailsWidthBounds(containerWidth);
  const step = largeStep
    ? TRAJECTORY_DETAILS_KEYBOARD_LARGE_STEP
    : TRAJECTORY_DETAILS_KEYBOARD_STEP;
  switch (key) {
    case "ArrowLeft":
      return clampTrajectoryDetailsWidth(width + step, containerWidth);
    case "ArrowRight":
      return clampTrajectoryDetailsWidth(width - step, containerWidth);
    case "Home":
      return bounds.min;
    case "End":
      return bounds.max;
    default:
      return null;
  }
}
