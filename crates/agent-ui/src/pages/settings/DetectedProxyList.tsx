import type { SystemProxyType } from "@liveagent/app/lib/settings";
import { invoke } from "@liveagent/app/shims/tauriCore";
import { RefreshCw } from "@liveagent/ui/components/IconSet";
import { Skeleton } from "@liveagent/ui/components/ui/skeleton";
import { useLocale } from "@liveagent/ui/i18n/index";
import { isGatewayWebuiRuntime } from "@liveagent/ui/lib/runtimeEnv";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { useCallback, useEffect, useRef, useState } from "react";

// 与桌面 services/proxy_detect 的 camelCase 序列化一致；WebUI 经 Gateway 拿到同一份 JSON。
export type DetectedProxySource = "os" | "env" | "listen" | "gateway";

export type DetectedProxy = {
  id: string;
  type: SystemProxyType;
  host: string;
  port: number;
  processName: string | null;
  sources: DetectedProxySource[];
  authRequired: boolean;
};

type ProxyTestResult = {
  ok: boolean;
  latencyMs: number | null;
  error: string | null;
};

type TestState = { status: "pending" } | ({ status: "done" } & ProxyTestResult);

const SOURCE_LABEL_KEYS: Record<DetectedProxySource, string> = {
  os: "settings.systemProxySourceOs",
  env: "settings.systemProxySourceEnv",
  listen: "settings.systemProxySourceListen",
  gateway: "settings.systemProxySourceGateway",
};

function testErrorText(error: string | null, t: (key: string) => string) {
  if (error?.startsWith("status:")) {
    return t("settings.systemProxyTestStatus").replace("{status}", error.slice("status:".length));
  }
  if (error === "timeout") return t("settings.systemProxyTestTimeout");
  if (error === "connect") return t("settings.systemProxyTestConnect");
  return t("settings.systemProxyTestRequest");
}

/**
 * 应用代理设置里「端口」下方的候选按钮：打开设置时自动检测一次本机正在运行的
 * 代理服务，点击只填写类型、地址、端口，不改代理开关。检测与测速都在桌面端执行。
 */
export function DetectedProxyList(props: {
  current: { type: SystemProxyType; host: string; port: number };
  onSelect: (proxy: DetectedProxy) => void;
}) {
  const { current, onSelect } = props;
  const { t } = useLocale();
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [candidates, setCandidates] = useState<DetectedProxy[]>([]);
  const [tests, setTests] = useState<Record<string, TestState>>({});
  // 每次检测递增；旧一轮的检测/测速结果晚到时直接丢弃。
  const runRef = useRef(0);

  const detect = useCallback(async () => {
    const run = ++runRef.current;
    setStatus("loading");
    setTests({});
    let found: DetectedProxy[];
    try {
      const result = await invoke<{ candidates: DetectedProxy[] }>("system_proxy_detect");
      found = Array.isArray(result?.candidates) ? result.candidates : [];
    } catch {
      if (runRef.current === run) setStatus("error");
      return;
    }
    if (runRef.current !== run) return;
    setCandidates(found);
    setStatus("ready");
    setTests(Object.fromEntries(found.map((proxy) => [proxy.id, { status: "pending" }])));
    for (const proxy of found) {
      invoke<ProxyTestResult>("system_proxy_test", {
        input: { type: proxy.type, host: proxy.host, port: proxy.port },
      })
        .catch(() => ({ ok: false, latencyMs: null, error: "request" }))
        .then((result) => {
          if (runRef.current !== run) return;
          setTests((prev) => ({ ...prev, [proxy.id]: { status: "done", ...result } }));
        });
    }
  }, []);

  useEffect(() => {
    void detect();
    return () => {
      runRef.current += 1;
    };
  }, [detect]);

  const loading = status === "loading";

  return (
    <div className="space-y-2" aria-busy={loading}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="text-xs font-medium text-muted-foreground">
          {t("settings.systemProxyDetected")}
        </span>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-settings-tile-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
          onClick={() => void detect()}
          disabled={loading}
        >
          <RefreshCw className={cn("size-3.5", loading && "animate-spin")} aria-hidden />
          {t("settings.systemProxyDetectAgain")}
        </button>
      </div>
      {isGatewayWebuiRuntime() ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("settings.systemProxyDetectHostHint")}
        </p>
      ) : null}

      {loading ? (
        <div className="flex flex-wrap gap-2" role="status">
          <span className="sr-only">{t("settings.systemProxyDetecting")}</span>
          <Skeleton className="h-8 w-44 rounded-lg" />
          <Skeleton className="h-8 w-36 rounded-lg" />
        </div>
      ) : status === "error" ? (
        <p className="text-xs text-destructive">{t("settings.systemProxyDetectFailed")}</p>
      ) : candidates.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("settings.systemProxyDetectEmpty")}</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {candidates.map((proxy) => {
            const test = tests[proxy.id];
            const failureText =
              test?.status === "done" && !test.ok ? testErrorText(test.error, t) : null;
            const failed = failureText !== null;
            const isCurrent =
              proxy.type === current.type &&
              proxy.host === current.host.trim() &&
              proxy.port === current.port;
            const typeLabel = proxy.type === "socks5" ? "SOCKS5" : "HTTP";
            const target = proxy.host.includes(":")
              ? `[${proxy.host}]:${proxy.port}`
              : `${proxy.host}:${proxy.port}`;
            const name = proxy.processName ?? t(SOURCE_LABEL_KEYS[proxy.sources[0] ?? "listen"]);
            const sourceText = proxy.sources
              .map((source) => t(SOURCE_LABEL_KEYS[source]))
              .join(" · ");
            return (
              <li key={proxy.id} className="min-w-0 max-w-full">
                <button
                  type="button"
                  aria-pressed={isCurrent}
                  aria-label={t("settings.systemProxyDetectFill").replace(
                    "{target}",
                    `${typeLabel} ${target}`,
                  )}
                  title={failureText ? `${sourceText}\n${failureText}` : sourceText}
                  onClick={() => onSelect(proxy)}
                  className={cn(
                    "flex max-w-full flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded-lg bg-settings-tile-hover px-2.5 py-1.5 text-left text-xs transition-colors",
                    "hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    isCurrent && "ring-1 ring-primary/50",
                    failed && "text-muted-foreground",
                  )}
                >
                  <span className="font-medium">{typeLabel}</span>
                  <span className="break-all font-mono">{target}</span>
                  <span className="break-all text-muted-foreground">· {name}</span>
                  <span
                    className={cn(
                      "tabular-nums",
                      test?.status === "done" && test.ok
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-muted-foreground",
                    )}
                  >
                    ·{" "}
                    {test?.status === "done"
                      ? test.ok
                        ? `${test.latencyMs ?? 0}ms`
                        : t("settings.systemProxyDetectUnavailable")
                      : t("settings.systemProxyDetectTesting")}
                  </span>
                  {proxy.authRequired ? (
                    <span className="rounded bg-background px-1 text-[11px] text-muted-foreground">
                      {t("settings.systemProxyDetectAuth")}
                    </span>
                  ) : null}
                  {isCurrent ? (
                    <span className="rounded bg-primary/10 px-1 text-[11px] text-primary">
                      {t("settings.systemProxyDetectCurrent")}
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
