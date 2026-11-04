/** macOS / iOS user agents use Cmd (⌘) where other platforms use Ctrl. */
export function isMacLikePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/i.test(`${navigator.userAgent} ${navigator.platform}`);
}
