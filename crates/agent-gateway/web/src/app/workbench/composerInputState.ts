export function resolveWorkbenchComposerInputDisabled(options: {
  isPrimary: boolean;
  primaryInputDisabled: boolean;
  transportInputDisabled: boolean;
  conversationIsCompacting: boolean;
}): boolean {
  return (
    options.transportInputDisabled ||
    options.conversationIsCompacting ||
    (options.isPrimary && options.primaryInputDisabled)
  );
}
