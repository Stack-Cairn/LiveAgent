export { assistantMessageToText } from "@liveagent/ui/lib/providers/errorMessage";

export function createStreamingTextReconciler() {
  const emittedTextByKey = new Map<string, string>();

  return {
    appendDelta(key: string, delta: string) {
      if (!delta) return "";
      const previous = emittedTextByKey.get(key) ?? "";
      emittedTextByKey.set(key, previous + delta);
      return delta;
    },
    reconcileFinalText(key: string, finalText: string) {
      if (!finalText) return "";

      const previous = emittedTextByKey.get(key) ?? "";
      emittedTextByKey.set(key, finalText);

      if (!previous) {
        return finalText;
      }
      if (finalText.startsWith(previous)) {
        return finalText.slice(previous.length);
      }
      return "";
    },
  };
}
