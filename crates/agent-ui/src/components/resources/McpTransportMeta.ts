import { Globe2, Terminal, Wifi } from "@liveagent/ui/components/IconSet";

export function getMcpTransportMeta(transport: string) {
  if (transport === "http") return { label: "http", Icon: Globe2 } as const;
  if (transport === "sse") return { label: "sse", Icon: Wifi } as const;
  return { label: "stdio", Icon: Terminal } as const;
}
