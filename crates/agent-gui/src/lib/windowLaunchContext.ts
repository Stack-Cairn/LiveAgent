export type AppWindowLaunchContext =
  | { kind: "main" }
  | { kind: "conversation"; conversationId: string; conversationTitle: string };

export function parseAppWindowLaunchContext(search: string): AppWindowLaunchContext {
  const params = new URLSearchParams(search);
  if (params.get("appWindow") !== "conversation") {
    return { kind: "main" };
  }

  const conversationId = params.get("conversationId")?.trim() ?? "";
  if (!conversationId) {
    return { kind: "main" };
  }

  return {
    kind: "conversation",
    conversationId,
    conversationTitle: params.get("conversationTitle")?.trim() ?? "",
  };
}

export function readAppWindowLaunchContext(): AppWindowLaunchContext {
  if (typeof window === "undefined") {
    return { kind: "main" };
  }
  return parseAppWindowLaunchContext(window.location.search);
}
