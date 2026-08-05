import { ChevronDown, Globe, Trash2 } from "../../components/icons";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { Textarea } from "../../components/ui/textarea";
import { useLocale } from "../../i18n";
import {
  canHttpMethodHaveBody,
  HTTP_METHODS,
  type HttpMethod,
  type HttpRequestSpec,
} from "../../lib/automation";
import { createUuid } from "../../lib/shared/id";

export type HttpRequestDraft = {
  id: string;
  url: string;
  method: HttpMethod;
  headersText: string;
  bodyText: string;
};

export function createEmptyRequestDraft(): HttpRequestDraft {
  return {
    id: createUuid(),
    url: "",
    method: "POST",
    headersText: "",
    bodyText: "",
  };
}

function stringifyHeaders(headers?: Record<string, string>) {
  if (!headers || Object.keys(headers).length === 0) return "";
  return JSON.stringify(headers, null, 2);
}

function stringifyBody(body?: unknown) {
  if (body === undefined) return "";
  return JSON.stringify(body, null, 2);
}

export function requestToDraft(request?: HttpRequestSpec): HttpRequestDraft {
  if (!request) return createEmptyRequestDraft();
  return {
    id: request.id,
    url: request.url,
    method: request.method,
    headersText: stringifyHeaders(request.headers),
    bodyText: stringifyBody(request.body),
  };
}

function parseHeaders(input: string, invalidMessage: string) {
  if (!input.trim()) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error(invalidMessage);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(invalidMessage);
  }

  const headers: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(parsed as Record<string, unknown>)) {
    const key = String(rawKey).trim();
    const value = typeof rawValue === "string" ? rawValue.trim() : String(rawValue ?? "").trim();
    if (!key || !value) continue;
    headers[key] = value;
  }

  return Object.keys(headers).length > 0 ? headers : undefined;
}

function parseBody(method: HttpMethod, input: string, invalidMessage: string) {
  if (!canHttpMethodHaveBody(method)) return undefined;
  if (!input.trim()) return undefined;
  try {
    return JSON.parse(input);
  } catch {
    throw new Error(invalidMessage);
  }
}

export function parseHttpRequestDrafts(
  requests: HttpRequestDraft[],
  t: (key: string) => string,
): HttpRequestSpec[] {
  if (requests.length === 0) {
    throw new Error(t("settings.cronHttpRequestRequired"));
  }

  return requests.map((request, index) => {
    const url = request.url.trim();
    if (!url) {
      throw new Error(`${t("settings.cronHttpUrlRequired")} #${index + 1}`);
    }
    try {
      new URL(url);
    } catch {
      throw new Error(`${t("settings.cronHttpUrlInvalid")} #${index + 1}`);
    }

    return {
      id: request.id,
      url,
      method: request.method,
      headers: parseHeaders(request.headersText, t("settings.cronHttpHeadersInvalid")),
      body: parseBody(request.method, request.bodyText, t("settings.cronHttpBodyInvalid")),
    } satisfies HttpRequestSpec;
  });
}

type HttpRequestListEditorProps = {
  requests: HttpRequestDraft[];
  expandedRequestId: string | null;
  onExpand: (id: string | null) => void;
  onChange: (requests: HttpRequestDraft[]) => void;
  /** Called before any edit so the host modal can clear its form error. */
  onDirty: () => void;
  urlPlaceholder: string;
};

export function HttpRequestListEditor({
  requests,
  expandedRequestId,
  onExpand,
  onChange,
  onDirty,
  urlPlaceholder,
}: HttpRequestListEditorProps) {
  const { t } = useLocale();

  function updateRequest(id: string, patch: Partial<HttpRequestDraft>) {
    onChange(requests.map((request) => (request.id === id ? { ...request, ...patch } : request)));
  }

  return (
    <div className="space-y-3">
      {requests.map((request, index) => {
        const bodyEnabled = canHttpMethodHaveBody(request.method);
        const isExpanded = expandedRequestId === request.id;

        return (
          <div
            key={request.id}
            className="overflow-hidden rounded-xl border border-border/60 bg-background/80 transition-colors hover:border-border/80"
          >
            <div className="settings-http-row flex items-center gap-3 px-4 py-3">
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-xs font-bold text-emerald-600 dark:text-emerald-400">
                {index + 1}
              </div>

              <Select
                value={request.method}
                onValueChange={(value) => {
                  onDirty();
                  updateRequest(request.id, {
                    method: value as HttpMethod,
                    bodyText: canHttpMethodHaveBody(value as HttpMethod) ? request.bodyText : "",
                  });
                }}
              >
                <SelectTrigger className="h-8 w-[100px] text-xs font-semibold">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HTTP_METHODS.map((method) => (
                    <SelectItem key={method} value={method}>
                      {method}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Input
                value={request.url}
                placeholder={urlPlaceholder}
                className="h-8 flex-1 font-mono text-xs"
                onChange={(e) => {
                  onDirty();
                  updateRequest(request.id, { url: e.currentTarget.value });
                }}
              />

              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => onExpand(isExpanded ? null : request.id)}
                  className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-muted/50 ${
                    isExpanded ? "text-primary" : "text-muted-foreground"
                  }`}
                >
                  <ChevronDown
                    className={`h-3.5 w-3.5 transition-transform ${isExpanded ? "" : "-rotate-90"}`}
                  />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onDirty();
                    onChange(requests.filter((item) => item.id !== request.id));
                    if (expandedRequestId === request.id) {
                      onExpand(null);
                    }
                  }}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                  title={t("settings.delete")}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            {isExpanded ? (
              <div className="border-t border-border/30 bg-muted/10 px-4 py-4">
                <div className="settings-form-grid grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium text-muted-foreground">Headers</Label>
                    <Textarea
                      value={request.headersText}
                      placeholder={'{\n  "Authorization": "Bearer ..."\n}'}
                      className="min-h-[100px] resize-y font-mono text-xs leading-relaxed"
                      onChange={(e) => {
                        onDirty();
                        updateRequest(request.id, { headersText: e.currentTarget.value });
                      }}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium text-muted-foreground">Body</Label>
                    {bodyEnabled ? (
                      <Textarea
                        value={request.bodyText}
                        placeholder={'{\n  "message": "hello"\n}'}
                        className="min-h-[100px] resize-y font-mono text-xs leading-relaxed"
                        onChange={(e) => {
                          onDirty();
                          updateRequest(request.id, { bodyText: e.currentTarget.value });
                        }}
                      />
                    ) : (
                      <div className="flex min-h-[100px] items-center justify-center rounded-lg border border-dashed border-border/50 bg-muted/10 text-xs text-muted-foreground/60">
                        {t("settings.cronHttpBodyDisabled")}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        );
      })}

      {requests.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/50 bg-muted/5 py-8 text-center">
          <Globe className="mx-auto h-6 w-6 text-muted-foreground/30" />
          <p className="mt-2 text-xs text-muted-foreground">
            {t("settings.cronHttpRequestRequired")}
          </p>
        </div>
      ) : null}
    </div>
  );
}
