import {
  type ComponentProps,
  createContext,
  type MouseEvent,
  memo,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { Components, ExtraProps } from "streamdown";
import { useLocale } from "../../i18n";
import { invokeFs } from "../../lib/tools/fsBackend";
import { ExternalLinkModal, Markdown } from "../Markdown";
import {
  classifyWorkspaceMarkdownTarget,
  workspaceMarkdownHeadingSlug,
} from "./workspaceMarkdownAssets";

type WorkspaceMarkdownPreviewContextValue = {
  workdir: string;
  markdownPath: string;
  onOpenWorkspacePath?: (path: string) => void;
};

const WorkspaceMarkdownPreviewContext = createContext<WorkspaceMarkdownPreviewContextValue | null>(
  null,
);

type WorkspacePreviewFileResponse = {
  mimeType: string;
  data: string;
};

function base64ToBytes(data: string) {
  const binary = window.atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

type WorkspaceImageState =
  | { status: "loading" }
  | { status: "loaded"; url: string }
  | { status: "error" };

function useWorkspaceImageObjectUrl(workdir: string, path: string): WorkspaceImageState {
  const [state, setState] = useState<WorkspaceImageState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setState({ status: "loading" });
    invokeFs<WorkspacePreviewFileResponse>("fs_read_workspace_image", { workdir, path })
      .then((response) => {
        if (cancelled) return;
        const bytes = base64ToBytes(response.data);
        const blob = new Blob([bytes.slice().buffer], { type: response.mimeType });
        objectUrl = URL.createObjectURL(blob);
        setState({ status: "loaded", url: objectUrl });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [workdir, path]);

  return state;
}

function MarkdownImageUnavailable(props: { alt?: string; title?: string }) {
  const { alt, title } = props;
  const { t } = useLocale();
  const reason = t("workspaceFilePreview.imageUnavailable");
  const label = alt?.trim() || title?.trim() || "";
  return (
    <span
      className="text-xs italic text-muted-foreground"
      data-liveagent-markdown-image="text-fallback"
      title={label ? reason : undefined}
    >
      {label || reason}
    </span>
  );
}

function PreviewImage(props: { url: string; alt?: string; title?: string }) {
  const { url, alt, title } = props;
  const [failed, setFailed] = useState(false);
  if (failed) {
    return <MarkdownImageUnavailable alt={alt} title={title} />;
  }
  return (
    <img
      className="my-1 inline-block h-auto max-w-full rounded-md"
      data-liveagent-markdown-image="preview"
      src={url}
      alt={alt ?? ""}
      title={title}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

function WorkspacePreviewImage(props: {
  workdir: string;
  path: string;
  alt?: string;
  title?: string;
}) {
  const { workdir, path, alt, title } = props;
  const state = useWorkspaceImageObjectUrl(workdir, path);
  if (state.status === "loading") {
    return (
      <span
        className="inline-block h-4 w-20 animate-pulse rounded bg-muted align-middle"
        data-liveagent-markdown-image="loading"
      />
    );
  }
  if (state.status === "error") {
    return <MarkdownImageUnavailable alt={alt} title={title} />;
  }
  return <PreviewImage url={state.url} alt={alt} title={title} />;
}

type MarkdownPreviewImageProps = ComponentProps<"img"> & ExtraProps;

function WorkspaceMarkdownPreviewImage(props: MarkdownPreviewImageProps) {
  const { src, alt, title } = props;
  const context = useContext(WorkspaceMarkdownPreviewContext);
  const target = useMemo(
    () =>
      classifyWorkspaceMarkdownTarget(
        context?.markdownPath ?? "",
        typeof src === "string" ? src : null,
      ),
    [context?.markdownPath, src],
  );
  const altText = typeof alt === "string" ? alt : undefined;
  const titleText = typeof title === "string" ? title : undefined;

  if ((target.kind === "external" && /^https?:/i.test(target.url)) || target.kind === "inline") {
    return <PreviewImage url={target.url} alt={altText} title={titleText} />;
  }
  if (target.kind === "workspace" && context?.workdir) {
    return (
      <WorkspacePreviewImage
        workdir={context.workdir}
        path={target.path}
        alt={altText}
        title={titleText}
      />
    );
  }
  return <MarkdownImageUnavailable alt={altText} title={titleText} />;
}

const previewLinkClassName =
  "cursor-pointer appearance-none bg-transparent p-0 text-left font-medium text-primary underline decoration-primary/35 underline-offset-4 transition-colors hover:decoration-primary";

function InertMarkdownLink(props: { children: ReactNode; label?: string }) {
  const { children, label } = props;
  return (
    <span className="text-primary underline decoration-primary/35 underline-offset-4" title={label}>
      {children}
    </span>
  );
}

function scrollToMarkdownHeading(event: MouseEvent<HTMLButtonElement>, fragment: string) {
  const root = event.currentTarget.closest("[data-workspace-markdown-preview]");
  if (!root) return;
  const slug = workspaceMarkdownHeadingSlug(fragment);
  for (const heading of Array.from(root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6"))) {
    const text = heading.textContent ?? "";
    if (workspaceMarkdownHeadingSlug(text) === slug || text.trim() === fragment.trim()) {
      heading.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
  }
}

type MarkdownPreviewLinkProps = ComponentProps<"a"> & ExtraProps;

function WorkspaceMarkdownPreviewLink(props: MarkdownPreviewLinkProps) {
  const { children, href, title } = props;
  const context = useContext(WorkspaceMarkdownPreviewContext);
  const [confirmingUrl, setConfirmingUrl] = useState<string | null>(null);
  const target = useMemo(
    () =>
      classifyWorkspaceMarkdownTarget(
        context?.markdownPath ?? "",
        typeof href === "string" ? href : null,
      ),
    [context?.markdownPath, href],
  );
  const titleText = typeof title === "string" && title.trim() ? title.trim() : undefined;

  if (target.kind === "external") {
    return (
      <>
        <button
          type="button"
          className={previewLinkClassName}
          title={titleText ?? target.url}
          onClick={() => setConfirmingUrl(target.url)}
        >
          {children}
        </button>
        <ExternalLinkModal
          isOpen={confirmingUrl !== null}
          url={confirmingUrl ?? ""}
          onClose={() => setConfirmingUrl(null)}
          onConfirm={() => {
            const opened = window.open(target.url, "_blank", "noopener,noreferrer");
            if (opened) opened.opener = null;
          }}
        />
      </>
    );
  }

  if (target.kind === "hash") {
    return (
      <button
        type="button"
        className={previewLinkClassName}
        title={titleText}
        onClick={(event) => scrollToMarkdownHeading(event, target.fragment)}
      >
        {children}
      </button>
    );
  }

  if (target.kind === "workspace" && context?.onOpenWorkspacePath) {
    const openWorkspacePath = context.onOpenWorkspacePath;
    return (
      <button
        type="button"
        className={previewLinkClassName}
        title={titleText ?? target.path}
        onClick={() => openWorkspacePath(target.path)}
      >
        {children}
      </button>
    );
  }

  const fallbackLabel =
    titleText ?? (typeof href === "string" && href.trim() ? href.trim() : undefined);
  return <InertMarkdownLink label={fallbackLabel}>{children}</InertMarkdownLink>;
}

const workspaceMarkdownPreviewComponents: Components = {
  img: WorkspaceMarkdownPreviewImage,
  a: WorkspaceMarkdownPreviewLink,
};

type WorkspaceMarkdownPreviewProps = {
  workdir: string;
  markdownPath: string;
  content: string;
  className?: string;
  onOpenWorkspacePath?: (path: string) => void;
};

export const WorkspaceMarkdownPreview = memo(function WorkspaceMarkdownPreview(
  props: WorkspaceMarkdownPreviewProps,
) {
  const { workdir, markdownPath, content, className, onOpenWorkspacePath } = props;
  const contextValue = useMemo(
    () => ({ workdir, markdownPath, onOpenWorkspacePath }),
    [markdownPath, onOpenWorkspacePath, workdir],
  );
  return (
    <div data-workspace-markdown-preview="">
      <WorkspaceMarkdownPreviewContext.Provider value={contextValue}>
        <Markdown
          content={content}
          className={className}
          readOnly
          componentOverrides={workspaceMarkdownPreviewComponents}
          preserveRelativeUrls
        />
      </WorkspaceMarkdownPreviewContext.Provider>
    </div>
  );
});
