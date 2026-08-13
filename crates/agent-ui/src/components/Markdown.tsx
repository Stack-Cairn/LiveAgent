import { openUrl } from "@liveagent/app/shims/tauriOpener";
import { ChevronDown, ChevronUp, Copy, ExternalLink, X } from "@liveagent/ui/components/IconSet";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import {
  type ComponentProps,
  cloneElement,
  isValidElement,
  memo,
  type ReactElement,
  type ReactNode,
  useMemo,
  useState,
} from "react";
import remarkBreaks from "remark-breaks";
import {
  type Components,
  defaultRehypePlugins,
  defaultRemarkPlugins,
  type ExtraProps,
  type LinkSafetyModalProps,
  Streamdown,
  type StreamdownTranslations,
} from "streamdown";
import {
  type ChatFileLink,
  decodeChatFileLinkPayload,
  encodeChatFileLink,
  parseChatFileLink,
} from "../lib/chat/chatFileLinks";
import {
  getCollapsedCodeBlockPreview,
  resolveCodeBlockRenderPolicy,
} from "../lib/markdownCodeBlockPolicy";
import { normalizeLatexDelimiters } from "../lib/normalizeLatexDelimiters";
import { cn } from "../lib/shared/utils";
import { Button } from "./ui/button";
import { CopyButton } from "./ui/copy-button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";

const CHAT_FILE_NODE_DATA_KEY = "liveagentChatFileLink";
const LIVEAGENT_FILE_PROTOCOL = "liveagent-file:";

type ChatFileHastNode = {
  children?: ChatFileHastNode[];
  data?: Record<string, unknown>;
  properties?: Record<string, unknown>;
  position?: { start?: { offset?: number } };
  type?: string;
  tagName?: string;
};

type ChatFileVFile = { value?: unknown };

function visitChatFileElements(node: ChatFileHastNode, visitor: (node: ChatFileHastNode) => void) {
  if (node.type === "element") visitor(node);
  for (const child of node.children ?? []) visitChatFileElements(child, visitor);
}

export function rewriteChatFileLinks() {
  return (tree: unknown, file?: ChatFileVFile) => {
    visitChatFileElements(tree as ChatFileHastNode, (node) => {
      if (node.tagName !== "a") return;
      const source = typeof file?.value === "string" ? file.value : "";
      const sourceOffset = node.position?.start?.offset;
      // Raw HTML anchors keep their source position after rehype-raw. They
      // must not acquire the trusted marker that only Markdown links receive.
      if (sourceOffset !== undefined && source[sourceOffset] === "<") return;
      const href = typeof node.properties?.href === "string" ? node.properties.href : "";
      const parsed = parseChatFileLink(href);
      if (!parsed) return;
      const internalHref = encodeChatFileLink(parsed);
      node.properties = { ...node.properties, href: internalHref };
      node.data = { ...node.data, [CHAT_FILE_NODE_DATA_KEY]: internalHref };
    });
  };
}

type ChatFileMdastNode = {
  children?: ChatFileMdastNode[];
  position?: { start?: { offset?: number }; end?: { offset?: number } };
  type?: string;
  url?: string;
  value?: string;
};

const CHAT_FILE_MARKDOWN_LINK_PATTERN = /\[([^\]\n]+)\]\(([^)\n]+)\)/g;
const SKIPPED_CHAT_FILE_MDAST_NODES = new Set(["code", "html", "image", "inlineCode", "link"]);
const COMMONMARK_ESCAPABLE_CHARACTER = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;

function mapDecodedSourceOffsets(sourceValue: string, value: string) {
  let decoded = "";
  const rawOffsets: number[] = [];
  for (let index = 0; index < sourceValue.length; index += 1) {
    const next = sourceValue[index + 1];
    if (sourceValue[index] === "\\" && next && COMMONMARK_ESCAPABLE_CHARACTER.test(next)) {
      decoded += next;
      rawOffsets.push(index + 1);
      index += 1;
    } else {
      decoded += sourceValue[index];
      rawOffsets.push(index);
    }
  }
  return decoded === value ? rawOffsets : null;
}

function rewriteChatFileTextNode(node: ChatFileMdastNode, source: string) {
  const value = node.value ?? "";
  const sourceStart = node.position?.start?.offset;
  const sourceEnd = node.position?.end?.offset;
  const sourceValue =
    sourceStart !== undefined && sourceEnd !== undefined
      ? source.slice(sourceStart, sourceEnd)
      : "";
  const rawOffsets = mapDecodedSourceOffsets(sourceValue, value);
  if (!rawOffsets) return null;
  const nodes: ChatFileMdastNode[] = [];
  let cursor = 0;
  for (const match of value.matchAll(CHAT_FILE_MARKDOWN_LINK_PATTERN)) {
    const index = match.index ?? 0;
    const sourceIndex = rawOffsets[index];
    let backslashes = 0;
    for (let offset = sourceIndex - 1; offset >= 0 && sourceValue[offset] === "\\"; offset -= 1) {
      backslashes += 1;
    }
    if (backslashes % 2 === 1) continue;
    const destination = match[2].trim();
    if (!parseChatFileLink(destination)) continue;
    if (index > cursor) nodes.push({ type: "text", value: value.slice(cursor, index) });
    nodes.push({
      type: "link",
      url: destination,
      children: [{ type: "text", value: match[1] }],
    });
    cursor = index + match[0].length;
  }
  if (cursor === 0) return null;
  if (cursor < value.length) nodes.push({ type: "text", value: value.slice(cursor) });
  return nodes;
}

function rewriteChatFileMarkdownChildren(node: ChatFileMdastNode, source: string) {
  if (!node.children || SKIPPED_CHAT_FILE_MDAST_NODES.has(node.type ?? "")) return;
  for (let index = 0; index < node.children.length; index += 1) {
    const child = node.children[index];
    if (child.type === "text" && typeof child.value === "string") {
      const replacement = rewriteChatFileTextNode(child, source);
      if (!replacement) continue;
      node.children.splice(index, 1, ...replacement);
      index += replacement.length - 1;
      continue;
    }
    rewriteChatFileMarkdownChildren(child, source);
  }
}

export function remarkChatFileLinks() {
  return (tree: unknown, file?: ChatFileVFile) =>
    rewriteChatFileMarkdownChildren(
      tree as ChatFileMdastNode,
      typeof file?.value === "string" ? file.value : "",
    );
}

export type MarkdownProps = {
  content: string;
  className?: string;
  // Fixed render mode: content born from a live stream renders in Streamdown
  // streaming mode forever; history-born content renders static. The mode of
  // a given block never flips, so the streaming→static re-render (and its
  // full re-parse) cannot happen. Shiki themes are always active, so code
  // highlights identically in both modes and nothing re-highlights at settle.
  renderMode?: "streaming" | "static";
  // Caret visibility while tokens are arriving. Toggled via a className so
  // the flip never invalidates Streamdown's memoized blocks; the caret slot
  // itself stays mounted for the whole life of a streaming-mode block.
  showCaret?: boolean;
  readOnly?: boolean;
  // Extra component overrides merged over the built-in map. Used by the
  // workspace file preview to render images and links against workspace
  // files instead of the chat text fallbacks.
  componentOverrides?: Components;
  // Skip the harden rehype stage, which rewrites relative image/link URLs
  // against the page origin before they reach custom components. Sanitize
  // still runs, so scriptable protocols (javascript: etc.) never get through.
  preserveRelativeUrls?: boolean;
  // Chat file links are only rewritten when this explicit user-action callback
  // is present. Other Markdown surfaces keep Streamdown's normal link policy.
  workdir?: string;
  onOpenFileLink?: (link: ChatFileLink) => void;
};

const streamdownPlugins = { code, math, mermaid, cjk };
const remarkPlugins = [...Object.values(defaultRemarkPlugins), remarkBreaks];
const chatRemarkPlugins = [...remarkPlugins, remarkChatFileLinks];

type StreamdownRehypePlugins = NonNullable<ComponentProps<typeof Streamdown>["rehypePlugins"]>;

function createSanitizedRehypePlugins(options: {
  allowDataImages: boolean;
  preserveRelativeUrls: boolean;
  rewriteFileLinks: boolean;
}) {
  const sanitize = defaultRehypePlugins.sanitize;
  if (!Array.isArray(sanitize)) {
    return [
      defaultRehypePlugins.raw,
      ...(options.rewriteFileLinks ? [rewriteChatFileLinks] : []),
      sanitize,
      ...(options.preserveRelativeUrls ? [] : [defaultRehypePlugins.harden]),
    ] as StreamdownRehypePlugins;
  }
  const schema = (sanitize[1] ?? {}) as { protocols?: Record<string, unknown[]> };
  const srcProtocols = schema.protocols?.src;
  const hrefProtocols = schema.protocols?.href;
  const protocols = {
    ...schema.protocols,
    ...(options.rewriteFileLinks
      ? {
          href: Array.isArray(hrefProtocols)
            ? [...new Set([...hrefProtocols, "liveagent-file"])]
            : ["http", "https", "mailto", "liveagent-file"],
        }
      : {}),
    ...(options.allowDataImages
      ? {
          src: Array.isArray(srcProtocols)
            ? [...new Set([...srcProtocols, "data"])]
            : ["http", "https", "data"],
        }
      : {}),
  };
  return [
    defaultRehypePlugins.raw,
    ...(options.rewriteFileLinks ? [rewriteChatFileLinks] : []),
    [sanitize[0], { ...schema, protocols }],
    ...(options.preserveRelativeUrls ? [] : [defaultRehypePlugins.harden]),
  ] as StreamdownRehypePlugins;
}

// Workspace previews intentionally skip harden so relative assets reach their
// custom renderer. Chat surfaces always use raw → rewrite → sanitize → harden.
export const relativeUrlRehypePlugins = createSanitizedRehypePlugins({
  allowDataImages: true,
  preserveRelativeUrls: true,
  rewriteFileLinks: false,
});
export const chatFileRehypePlugins = createSanitizedRehypePlugins({
  allowDataImages: false,
  preserveRelativeUrls: false,
  rewriteFileLinks: true,
});
const relativeChatFileRehypePlugins = createSanitizedRehypePlugins({
  allowDataImages: true,
  preserveRelativeUrls: true,
  rewriteFileLinks: true,
});

type MarkdownImageFallbackProps = ComponentProps<"img"> & ExtraProps;
type MarkdownAnchorFallbackProps = ComponentProps<"a"> & ExtraProps;
type MarkdownPreProps = ComponentProps<"pre"> & ExtraProps;
type StreamdownCodeChildProps = {
  children?: ReactNode;
  className?: string;
  "data-block"?: string;
};

type MarkdownFileLinkProps = ComponentProps<"a"> &
  ExtraProps & {
    onOpenFileLink: (link: ChatFileLink) => void;
    workdir?: string;
  };

const DEFAULT_CODE_BLOCK_LANGUAGE = "markdown";

function readRewrittenChatFileLink(props: MarkdownAnchorFallbackProps) {
  const href = typeof props.href === "string" ? props.href : "";
  const marker = (props.node as ChatFileHastNode | undefined)?.data?.[CHAT_FILE_NODE_DATA_KEY];
  if (!href.startsWith(LIVEAGENT_FILE_PROTOCOL) || marker !== href) return null;
  const parsed = decodeChatFileLinkPayload(href.slice(LIVEAGENT_FILE_PROTOCOL.length));
  if (!parsed || encodeChatFileLink(parsed) !== href) return null;
  return parsed;
}

export function MarkdownFileLink(props: MarkdownFileLinkProps) {
  const { children, title, onOpenFileLink, workdir } = props;
  const parsed = readRewrittenChatFileLink(props);
  if (!parsed) return <MarkdownReadOnlyLink {...props} data-liveagent-file-link="blocked" />;
  const label =
    typeof title === "string" && title.trim()
      ? title.trim()
      : parsed.source === "relative" && workdir
        ? `${workdir.replace(/[\\/]+$/, "")}/${parsed.path.replace(/^[\\/]+/, "")}`
        : parsed.path;
  return (
    <button
      type="button"
      className="inline max-w-full cursor-pointer appearance-none whitespace-normal rounded-sm border-0 bg-transparent p-0 text-left font-medium text-primary underline decoration-primary/35 underline-offset-4 outline-none [overflow-wrap:anywhere] hover:decoration-primary focus-visible:ring-2 focus-visible:ring-ring/35"
      data-liveagent-file-link="true"
      title={label}
      onClick={() => onOpenFileLink(parsed)}
    >
      {children}
    </button>
  );
}

function MarkdownImageFallback(props: MarkdownImageFallbackProps) {
  const { alt, title } = props;
  const label =
    typeof alt === "string" && alt.trim()
      ? alt.trim()
      : typeof title === "string" && title.trim()
        ? title.trim()
        : "";
  if (!label) return null;
  return (
    <span
      className="text-xs italic text-muted-foreground"
      data-liveagent-markdown-image="text-fallback"
      title={label}
    >
      {label}
    </span>
  );
}

export const markdownComponents: Components = {
  img: MarkdownImageFallback,
  pre: CollapsibleCodePre,
};

function MarkdownReadOnlyLink(props: MarkdownAnchorFallbackProps) {
  const { children, href, title } = props;
  const label =
    typeof title === "string" && title.trim()
      ? title.trim()
      : typeof href === "string" && href.trim()
        ? href.trim()
        : undefined;
  return (
    <span className="text-primary underline decoration-primary/35 underline-offset-4" title={label}>
      {children}
    </span>
  );
}

export const markdownReadOnlyComponents: Components = {
  ...markdownComponents,
  a: MarkdownReadOnlyLink,
};

function MarkdownExternalLink(props: MarkdownAnchorFallbackProps) {
  const { children, className, href, title } = props;
  const [modalOpen, setModalOpen] = useState(false);
  if (!href) return <MarkdownReadOnlyLink {...props} />;
  const incomplete = href === "streamdown:incomplete-link";
  return (
    <>
      <button
        type="button"
        className={cn(
          "inline max-w-full cursor-pointer appearance-none whitespace-normal border-0 bg-transparent p-0 text-left font-medium text-primary underline [overflow-wrap:anywhere]",
          className,
        )}
        data-incomplete={incomplete}
        data-streamdown="link"
        title={title}
        onClick={() => {
          if (!incomplete) setModalOpen(true);
        }}
      >
        {children}
      </button>
      <ExternalLinkModal
        isOpen={modalOpen}
        url={href}
        onClose={() => setModalOpen(false)}
        onConfirm={() => window.open(href, "_blank", "noreferrer")}
      />
    </>
  );
}

export function MarkdownLink(props: MarkdownFileLinkProps) {
  if (readRewrittenChatFileLink(props)) return <MarkdownFileLink {...props} />;
  if (typeof props.href === "string" && props.href.startsWith(LIVEAGENT_FILE_PROTOCOL)) {
    return <MarkdownReadOnlyLink {...props} data-liveagent-file-link="blocked" />;
  }
  return <MarkdownExternalLink {...props} />;
}

function getCodeTextFromChild(child: ReactElement<StreamdownCodeChildProps>) {
  const raw = child.props.children;
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    return raw.filter((item): item is string => typeof item === "string").join("");
  }
  return "";
}

function getCodeLanguage(className?: string) {
  return className?.match(/language-([^\s]+)/)?.[1] ?? "";
}

function ensureCodeBlockLanguage(child: ReactElement<StreamdownCodeChildProps>) {
  if (getCodeLanguage(child.props.className)) return child;
  return cloneElement(child, {
    className: cn(child.props.className, `language-${DEFAULT_CODE_BLOCK_LANGUAGE}`),
  });
}

function CodeBlockActions({ code }: { code: string }) {
  const { t } = useLocale();

  return (
    <div className="pointer-events-none absolute right-0 top-0 z-20 flex h-8 items-center justify-end">
      <div className="pointer-events-auto flex shrink-0 items-center rounded-md bg-background/95 px-1.5 py-1">
        <CopyButton
          value={code}
          label={t("chat.markdown.copyCode")}
          copiedLabel={t("chat.markdown.copied")}
          className="h-6 w-6 p-1 hover:bg-foreground/[0.04]"
        />
      </div>
    </div>
  );
}

export function CollapsibleCodePre({ children }: MarkdownPreProps) {
  const { t } = useLocale();
  const childElement = isValidElement<StreamdownCodeChildProps>(children)
    ? ensureCodeBlockLanguage(children)
    : null;
  const codeContent = childElement ? getCodeTextFromChild(childElement) : "";
  const language = childElement ? getCodeLanguage(childElement.props.className) : "";
  const { lineCount, shouldCollapse } = resolveCodeBlockRenderPolicy(codeContent);
  const isMermaid = language === "mermaid" || language === "mmd";
  const isCollapsible = Boolean(childElement && !isMermaid && shouldCollapse);
  const [expanded, setExpanded] = useState(false);

  if (!childElement) return children;

  if (!isCollapsible) {
    const codeBlock = cloneElement(childElement, { "data-block": "true" });
    return (
      <div className="relative w-full">
        {isMermaid ? null : <CodeBlockActions code={codeContent} />}
        {codeBlock}
      </div>
    );
  }

  const previewContent = getCollapsedCodeBlockPreview(codeContent);

  return (
    <div className="relative w-full">
      <CodeBlockActions code={codeContent} />
      {expanded ? (
        <div className="w-full">{cloneElement(childElement, { "data-block": "true" })}</div>
      ) : (
        <div
          className="mt-2 w-full overflow-hidden rounded-xl bg-muted/40"
          data-liveagent-code-preview="collapsed"
        >
          <div className="flex h-8 items-center px-3 text-[11px] font-medium tracking-[0.06em] text-muted-foreground/85">
            {language || DEFAULT_CODE_BLOCK_LANGUAGE}
          </div>
          <pre className="!m-0 !overflow-x-auto !pb-2">
            <code className="block w-max min-w-full whitespace-pre py-4 font-mono text-[13px] leading-5 text-foreground/92">
              {previewContent}
            </code>
          </pre>
        </div>
      )}
      {expanded ? null : (
        <div className="pointer-events-none absolute inset-x-0 bottom-7 h-20 bg-gradient-to-b from-transparent via-background/70 to-background" />
      )}
      <div className="flex justify-center">
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.04] hover:text-foreground"
        >
          {expanded ? (
            <ChevronUp className="h-3.5 w-3.5" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5" />
          )}
          <span>
            {expanded
              ? t("chat.markdown.collapseCode")
              : t("chat.markdown.expandCode").replace("{count}", String(lineCount))}
          </span>
        </button>
      </div>
    </div>
  );
}

const streamdownTranslations = {
  close: "关闭",
  copied: "已复制",
  copyCode: "复制代码",
  copyLink: "复制链接",
  copyTable: "复制表格",
  copyTableAsCsv: "复制为 CSV",
  copyTableAsMarkdown: "复制为 Markdown",
  copyTableAsTsv: "复制为 TSV",
  downloadDiagram: "下载图表",
  downloadDiagramAsMmd: "下载为 Mermaid",
  downloadDiagramAsPng: "下载为 PNG",
  downloadDiagramAsSvg: "下载为 SVG",
  downloadFile: "下载文件",
  downloadImage: "下载图片",
  downloadTable: "下载表格",
  downloadTableAsCsv: "下载为 CSV",
  downloadTableAsMarkdown: "下载为 Markdown",
  exitFullscreen: "退出全屏",
  externalLinkWarning: "请确认目标站点可信后再继续。",
  imageNotAvailable: "图片暂不可用",
  mermaidFormatMmd: "Mermaid 源码",
  mermaidFormatPng: "PNG 图片",
  mermaidFormatSvg: "SVG 图片",
  openExternalLink: "打开外部链接",
  openLink: "打开链接",
  tableFormatCsv: "CSV",
  tableFormatMarkdown: "Markdown",
  tableFormatTsv: "TSV",
  viewFullscreen: "全屏查看",
} satisfies Partial<StreamdownTranslations>;

export function ExternalLinkModal({ isOpen, onClose, onConfirm, url }: LinkSafetyModalProps) {
  if (!isOpen || typeof document === "undefined") {
    return null;
  }

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(url);
    } catch (error) {
      console.error("Failed to copy external link", error);
    }
  };

  const handleOpenLink = async () => {
    try {
      await openUrl(url);
    } catch (error) {
      console.error("Failed to open external link via opener", error);
      onConfirm();
    } finally {
      onClose();
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="external-link-modal-panel max-w-[28rem] border-border/60 p-0 shadow-[0_20px_60px_-28px_rgba(0,0,0,0.45)]"
        overlayClassName="bg-black/25 backdrop-blur-[2px]"
      >
        <div className="flex items-start justify-between gap-4 px-5 pb-3 pt-5">
          <div className="min-w-0 space-y-1.5">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <ExternalLink className="size-4 text-muted-foreground" />
              <DialogTitle className="text-sm">
                {streamdownTranslations.openExternalLink}
              </DialogTitle>
            </div>
            <DialogDescription className="text-xs leading-5">
              {streamdownTranslations.externalLinkWarning}
            </DialogDescription>
          </div>
          <button
            type="button"
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            onClick={onClose}
            aria-label={streamdownTranslations.close}
          >
            <X className="size-3.5" />
          </button>
        </div>
        <div className="px-5 pb-5">
          <div className="flex min-h-10 items-center gap-2 rounded-xl bg-muted/55 px-3 py-2.5 text-muted-foreground">
            <ExternalLink className="size-3.5 shrink-0" />
            <p
              className="min-w-0 truncate font-mono text-xs leading-5 text-foreground/85"
              title={url}
            >
              {url}
            </p>
          </div>
          <div className="mt-4 flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              className="h-8 gap-1.5 rounded-lg px-3 text-xs font-normal text-muted-foreground shadow-none hover:bg-muted hover:text-foreground"
              onClick={handleCopyLink}
            >
              <Copy className="size-3.5" />
              <span>{streamdownTranslations.copyLink}</span>
            </Button>
            <Button
              type="button"
              variant="secondary"
              className="h-8 gap-1.5 rounded-lg bg-muted px-3 text-xs font-normal shadow-none hover:bg-muted/80"
              onClick={handleOpenLink}
            >
              <ExternalLink className="size-3.5" />
              <span>{streamdownTranslations.openLink}</span>
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const MARKDOWN_EMBED_CLASSNAME = cn(
  "min-w-0 max-w-full overflow-hidden [overflow-wrap:anywhere]",
  "[&_[data-streamdown='mermaid-block']]:my-4 [&_[data-streamdown='mermaid-block']]:flex [&_[data-streamdown='mermaid-block']]:!w-full [&_[data-streamdown='mermaid-block']]:min-w-0 [&_[data-streamdown='mermaid-block']]:gap-2 [&_[data-streamdown='mermaid-block']]:rounded-none [&_[data-streamdown='mermaid-block']]:border-0 [&_[data-streamdown='mermaid-block']]:bg-transparent [&_[data-streamdown='mermaid-block']]:p-0 [&_[data-streamdown='mermaid-block']]:shadow-none",
  "[&_[data-streamdown='mermaid-block']>div:last-child]:!w-full [&_[data-streamdown='mermaid-block']>div:last-child]:min-w-0 [&_[data-streamdown='mermaid-block']>div:last-child]:rounded-none [&_[data-streamdown='mermaid-block']>div:last-child]:border-0 [&_[data-streamdown='mermaid-block']>div:last-child]:bg-transparent [&_[data-streamdown='mermaid-block']>div:last-child]:p-0 [&_[data-streamdown='mermaid-block']>div:last-child]:shadow-none",
  "[&_[data-streamdown='mermaid']]:my-0 [&_[data-streamdown='mermaid']]:block [&_[data-streamdown='mermaid']]:!w-full [&_[data-streamdown='mermaid']]:max-h-[280px] [&_[data-streamdown='mermaid']]:min-w-0 [&_[data-streamdown='mermaid']]:overflow-hidden [&_[data-streamdown='mermaid']]:rounded-none [&_[data-streamdown='mermaid']]:border-0 [&_[data-streamdown='mermaid']]:bg-transparent [&_[data-streamdown='mermaid']]:shadow-none",
  "[&_[data-streamdown='mermaid']>div]:!w-full [&_[data-streamdown='mermaid']>div]:min-w-0 [&_[data-streamdown='mermaid']>div]:max-w-none",
  "[&_[data-streamdown='mermaid']_svg]:mx-auto [&_[data-streamdown='mermaid']_svg]:block [&_[data-streamdown='mermaid']_svg]:h-auto [&_[data-streamdown='mermaid']_svg]:max-h-[280px] [&_[data-streamdown='mermaid']_svg]:max-w-full [&_[data-streamdown='mermaid']_svg]:bg-transparent",
  "[&_[data-streamdown='mermaid']>div>div:first-child]:!left-0 [&_[data-streamdown='mermaid']>div>div:first-child]:rounded-none [&_[data-streamdown='mermaid']>div>div:first-child]:border-0 [&_[data-streamdown='mermaid']>div>div:first-child]:bg-transparent [&_[data-streamdown='mermaid']>div>div:first-child]:p-0 [&_[data-streamdown='mermaid']>div>div:first-child]:shadow-none [&_[data-streamdown='mermaid']>div>div:first-child]:backdrop-blur-none",
  "[&_[data-streamdown='mermaid-block-actions']]:gap-2 [&_[data-streamdown='mermaid-block-actions']]:rounded-none [&_[data-streamdown='mermaid-block-actions']]:border-0 [&_[data-streamdown='mermaid-block-actions']]:bg-transparent [&_[data-streamdown='mermaid-block-actions']]:p-0 [&_[data-streamdown='mermaid-block-actions']]:shadow-none [&_[data-streamdown='mermaid-block-actions']]:backdrop-blur-none",
  "[&_[data-streamdown='mermaid-block-actions']_svg]:size-3 [&_[data-streamdown='mermaid-block']_button>svg]:size-3",
  "[&_[data-streamdown='table-wrapper']]:my-4 [&_[data-streamdown='table-wrapper']]:!w-full [&_[data-streamdown='table-wrapper']]:min-w-0 [&_[data-streamdown='table-wrapper']]:gap-0 [&_[data-streamdown='table-wrapper']]:rounded-none [&_[data-streamdown='table-wrapper']]:border-0 [&_[data-streamdown='table-wrapper']]:bg-transparent [&_[data-streamdown='table-wrapper']]:p-0 [&_[data-streamdown='table-wrapper']]:shadow-none [&_[data-streamdown='table-wrapper']]:outline-none [&_[data-streamdown='table-wrapper']]:ring-0",
  "[&_[data-streamdown='table-wrapper']>div:last-child]:!w-full [&_[data-streamdown='table-wrapper']>div:last-child]:min-w-0 [&_[data-streamdown='table-wrapper']>div:last-child]:overflow-x-auto [&_[data-streamdown='table-wrapper']>div:last-child]:overflow-y-hidden [&_[data-streamdown='table-wrapper']>div:last-child]:rounded-none [&_[data-streamdown='table-wrapper']>div:last-child]:border-0 [&_[data-streamdown='table-wrapper']>div:last-child]:bg-transparent [&_[data-streamdown='table-wrapper']>div:last-child]:p-0 [&_[data-streamdown='table-wrapper']>div:last-child]:shadow-none [&_[data-streamdown='table-wrapper']>div:last-child]:outline-none [&_[data-streamdown='table-wrapper']>div:last-child]:ring-0",
  "[&_table]:my-2 [&_table]:!w-full [&_table]:!min-w-full [&_table]:max-w-none [&_table]:table-auto [&_table]:border-collapse [&_table]:rounded-none [&_table]:border-0 [&_table]:bg-transparent [&_table]:shadow-none [&_table]:outline-none [&_table]:ring-0",
  "[&_thead]:bg-transparent [&_tbody]:bg-transparent [&_tr]:border-b [&_tr]:border-border/50 [&_tr]:bg-transparent [&_tbody_tr:last-child]:border-b-0",
  "[&_th]:border-0 [&_th]:px-0 [&_th]:py-2 [&_th]:pr-8 [&_th]:text-left [&_th]:align-bottom [&_th]:font-semibold [&_th]:tracking-[-0.01em] [&_th]:text-foreground",
  "[&_td]:border-0 [&_td]:px-0 [&_td]:py-1 [&_td]:pr-8 [&_td]:align-middle [&_td]:leading-8 [&_td]:text-foreground/90",
  "[&_th:last-child]:pr-0 [&_td:last-child]:pr-0 [&_table_*]:outline-none [&_table_*]:ring-0",
  "[&_div:has(>table)]:rounded-none [&_div:has(>table)]:border-0 [&_div:has(>table)]:bg-transparent [&_div:has(>table)]:shadow-none [&_div:has(>table)]:outline-none [&_div:has(>table)]:ring-0",
  "[&_code:not(pre_code)]:whitespace-pre-wrap [&_code:not(pre_code)]:break-words [&_code:not(pre_code)]:rounded-md [&_code:not(pre_code)]:bg-foreground/[0.05] [&_code:not(pre_code)]:px-1.5 [&_code:not(pre_code)]:py-0.5 [&_code:not(pre_code)]:font-mono [&_code:not(pre_code)]:text-[0.92em] [&_code:not(pre_code)]:text-foreground [&_code:not(pre_code)]:[overflow-wrap:anywhere]",
  "[&_[data-streamdown='code-block']]:my-4 [&_[data-streamdown='code-block']]:!w-full [&_[data-streamdown='code-block']]:min-w-0 [&_[data-streamdown='code-block']]:gap-0 [&_[data-streamdown='code-block']]:rounded-none [&_[data-streamdown='code-block']]:border-0 [&_[data-streamdown='code-block']]:bg-transparent [&_[data-streamdown='code-block']]:p-0 [&_[data-streamdown='code-block']]:shadow-none [&_[data-streamdown='code-block']]:outline-none [&_[data-streamdown='code-block']]:ring-0",
  "[&_[data-streamdown='code-block']>div:first-child]:mt-2 [&_[data-streamdown='code-block']>div:first-child]:min-h-0 [&_[data-streamdown='code-block']>div:first-child]:justify-between [&_[data-streamdown='code-block']>div:first-child]:gap-2 [&_[data-streamdown='code-block']>div:first-child]:border-0 [&_[data-streamdown='code-block']>div:first-child]:bg-transparent [&_[data-streamdown='code-block']>div:first-child]:pb-6 [&_[data-streamdown='code-block']>div:first-child]:text-[11px] [&_[data-streamdown='code-block']>div:first-child]:font-medium [&_[data-streamdown='code-block']>div:first-child]:tracking-[0.06em] [&_[data-streamdown='code-block']>div:first-child]:text-muted-foreground/85 [&_[data-streamdown='code-block']>div:first-child]:shadow-none",
  "[&_[data-streamdown='code-block']>div:last-child]:!w-full [&_[data-streamdown='code-block']>div:last-child]:min-w-0 [&_[data-streamdown='code-block']>div:last-child]:rounded-none [&_[data-streamdown='code-block']>div:last-child]:border-0 [&_[data-streamdown='code-block']>div:last-child]:bg-transparent [&_[data-streamdown='code-block']>div:last-child]:p-0 [&_[data-streamdown='code-block']>div:last-child]:shadow-none",
  "[&_[data-streamdown='code-block-body']]:!rounded-xl [&_[data-streamdown='code-block-body']]:!bg-muted/40",
  "[&_pre]:my-0 [&_pre]:block [&_pre]:!w-full [&_pre]:!min-w-0 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:overflow-y-hidden [&_pre]:border-0 [&_pre]:bg-transparent [&_pre]:px-0 [&_pre]:pb-2 [&_pre]:pt-0 [&_pre]:shadow-none [&_pre]:outline-none [&_pre]:ring-0",
  "[&_pre>code]:block [&_pre>code]:w-max [&_pre>code]:min-w-full [&_pre>code]:max-w-none [&_pre>code]:border-0 [&_pre>code]:bg-transparent [&_pre>code]:py-4 [&_pre>code]:font-mono [&_pre>code]:text-[13px] [&_pre>code]:leading-5 [&_pre>code]:text-foreground/92 [&_pre>code]:shadow-none [&_pre>code]:outline-none [&_pre>code]:ring-0",
  "[&_strong]:font-medium [&_[data-streamdown='strong']]:font-medium",
);

export const Markdown = memo(function Markdown(props: MarkdownProps) {
  const {
    content,
    className,
    renderMode = "static",
    showCaret = false,
    readOnly = false,
    componentOverrides,
    preserveRelativeUrls = false,
    workdir,
    onOpenFileLink,
  } = props;
  const streaming = renderMode === "streaming";
  const normalizedContent = useMemo(
    () => normalizeLatexDelimiters(content, streaming && showCaret),
    [content, showCaret, streaming],
  );
  const components = useMemo(() => {
    const baseComponents = readOnly ? markdownReadOnlyComponents : markdownComponents;
    const fileLinkComponents: Components =
      !readOnly && onOpenFileLink
        ? {
            a: (linkProps) => (
              <MarkdownLink {...linkProps} workdir={workdir} onOpenFileLink={onOpenFileLink} />
            ),
          }
        : {};
    return { ...baseComponents, ...fileLinkComponents, ...componentOverrides };
  }, [componentOverrides, onOpenFileLink, readOnly, workdir]);
  const rehypePlugins = onOpenFileLink
    ? preserveRelativeUrls
      ? relativeChatFileRehypePlugins
      : chatFileRehypePlugins
    : preserveRelativeUrls
      ? relativeUrlRehypePlugins
      : undefined;

  return (
    <div>
      <Streamdown
        className={cn(
          "chat-markdown max-w-none break-words",
          MARKDOWN_EMBED_CLASSNAME,
          streaming ? "chat-markdown--streaming" : "chat-markdown--static",
          showCaret ? "chat-markdown--caret-on" : "chat-markdown--caret-off",
          className,
        )}
        plugins={streamdownPlugins}
        remarkPlugins={onOpenFileLink ? chatRemarkPlugins : remarkPlugins}
        {...(rehypePlugins ? { rehypePlugins } : {})}
        components={components}
        mode={streaming ? "streaming" : "static"}
        dir="auto"
        parseIncompleteMarkdown
        normalizeHtmlIndentation
        isAnimating={showCaret}
        caret={streaming ? "block" : undefined}
        animated={false}
        linkSafety={{
          enabled: !readOnly,
          renderModal: (modalProps) => <ExternalLinkModal {...modalProps} />,
        }}
        shikiTheme={["github-light", "github-dark"] as const}
        controls={{
          code: false,
          mermaid: { copy: !readOnly, download: false, fullscreen: !readOnly, panZoom: !readOnly },
          table: false,
        }}
        translations={streamdownTranslations}
      >
        {normalizedContent}
      </Streamdown>
    </div>
  );
});
